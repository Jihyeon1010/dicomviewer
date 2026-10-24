//! Finds a Python that works and says what is missing for a plugin. Python is not shipped
//! with the app, so every candidate is run once to see that it really is a Python of a
//! usable version. Nothing is installed.
//!
//! The choice of candidates and the reading of the answers are plain functions without
//! side effects, so they can be tested without Python on the machine.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Oldest Python that plugins may rely on
pub const MIN_VERSION: (u32, u32) = (3, 9);

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// A way to start Python: a program and the arguments that come before the script
/// (`py -3` on Windows needs one).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Candidate {
    pub program: String,
    pub args: Vec<String>,
}

impl Candidate {
    fn new(program: &str, args: &[&str]) -> Candidate {
        Candidate {
            program: program.to_string(),
            args: args.iter().map(|a| (*a).to_string()).collect(),
        }
    }

    /// As it would be typed, for messages
    pub fn display(&self) -> String {
        std::iter::once(self.program.as_str())
            .chain(self.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PythonInfo {
    pub version: (u32, u32, u32),
    /// `sys.executable`: the file that runs
    pub executable: String,
    /// How the app starts it
    pub command: Candidate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Windows,
    MacOs,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "windows") {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::MacOs
        } else {
            Os::Linux
        }
    }
}

// ---------- Pure parts ----------

/// What the probe script prints: the version numbers on one line, `sys.executable` on the next.
pub const PROBE_SCRIPT: &str =
    "import sys; print(*sys.version_info[:3]); print(sys.executable)";

pub fn parse_probe_output(out: &str, command: &Candidate) -> Result<PythonInfo, String> {
    let mut lines = out.lines().map(str::trim).filter(|l| !l.is_empty());
    let version_line = lines.next().ok_or("no answer from Python")?;
    let nums: Vec<u32> = version_line
        .split_whitespace()
        .map(|n| n.parse::<u32>().map_err(|_| format!("unexpected answer: {version_line}")))
        .collect::<Result<_, _>>()?;
    let [major, minor, patch] = nums[..] else {
        return Err(format!("unexpected answer: {version_line}"));
    };
    Ok(PythonInfo {
        version: (major, minor, patch),
        executable: lines.next().unwrap_or("").to_string(),
        command: command.clone(),
    })
}

pub fn is_supported(version: (u32, u32, u32)) -> bool {
    (version.0, version.1) >= MIN_VERSION
}

/// Places to look, best first. `configured` is the path the user chose; when there is one it
/// is the only candidate, since a choice must not silently be replaced by another Python.
/// `apple_tools` tells whether the command line tools of Xcode are installed: without them
/// `/usr/bin/python3` is not a Python but a stub that opens an installation dialog, so it is
/// left out. `shell_python` is what the login shell finds (programs started from the Dock
/// do not get the PATH of a terminal).
pub fn candidates(
    configured: Option<&str>,
    os: Os,
    home: Option<&Path>,
    apple_tools: bool,
    shell_python: Option<&str>,
) -> Vec<Candidate> {
    if let Some(path) = configured.map(str::trim).filter(|p| !p.is_empty()) {
        return vec![Candidate::new(path, &[])];
    }

    let mut out: Vec<Candidate> = Vec::new();
    let mut add = |c: Candidate| {
        if !out.contains(&c) {
            out.push(c);
        }
    };
    let under_home = |rel: &str| -> Option<String> {
        home.map(|h| h.join(rel).to_string_lossy().into_owned())
    };
    // Environments that people make themselves
    let conda = ["miniconda3", "anaconda3", "miniforge3", "mambaforge"];

    match os {
        Os::Windows => {
            // The launcher knows every installed Python; the plain names may be the
            // Microsoft Store stubs, which fail when they are run
            add(Candidate::new("py", &["-3"]));
            add(Candidate::new("python", &[]));
            add(Candidate::new("python3", &[]));
            for c in conda {
                if let Some(p) = under_home(&format!("{c}\\python.exe")) {
                    add(Candidate::new(&p, &[]));
                }
            }
        }
        Os::MacOs => {
            if let Some(p) = shell_python {
                add(Candidate::new(p, &[]));
            }
            add(Candidate::new("/opt/homebrew/bin/python3", &[]));
            add(Candidate::new("/usr/local/bin/python3", &[]));
            if let Some(p) = under_home(".pyenv/shims/python3") {
                add(Candidate::new(&p, &[]));
            }
            for c in conda {
                if let Some(p) = under_home(&format!("{c}/bin/python")) {
                    add(Candidate::new(&p, &[]));
                }
            }
            if apple_tools {
                add(Candidate::new("python3", &[]));
                add(Candidate::new("/usr/bin/python3", &[]));
            }
        }
        Os::Linux => {
            if let Some(p) = shell_python {
                add(Candidate::new(p, &[]));
            }
            add(Candidate::new("python3", &[]));
            add(Candidate::new("python", &[]));
            add(Candidate::new("/usr/bin/python3", &[]));
            add(Candidate::new("/usr/local/bin/python3", &[]));
            if let Some(p) = under_home(".pyenv/shims/python3") {
                add(Candidate::new(&p, &[]));
            }
            for c in conda {
                if let Some(p) = under_home(&format!("{c}/bin/python")) {
                    add(Candidate::new(&p, &[]));
                }
            }
        }
    }
    out
}

/// The name that `pip` knows a requirement by: "numpy>=1.20" -> "numpy",
/// "scikit-image[extra]" -> "scikit-image". None for anything that is not a plain name, so
/// that text from a plugin never reaches Python as anything but a harmless word.
pub fn distribution_name(requirement: &str) -> Option<String> {
    let end = requirement
        .find(|c: char| matches!(c, '<' | '>' | '=' | '!' | '~' | ';' | '[' | ' ' | '('))
        .unwrap_or(requirement.len());
    let name = requirement[..end].trim();
    let ok = !name.is_empty()
        && name.len() <= 100
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
    ok.then(|| name.to_string())
}

/// Python code that prints the packages (given as arguments) that are not installed. A raw
/// string: in an ordinary one a backslash at the end of a line would swallow the indentation
/// that Python needs.
pub const MISSING_SCRIPT: &str = r#"import sys, importlib.metadata as m
missing = []
for n in sys.argv[1:]:
    try:
        m.version(n)
    except m.PackageNotFoundError:
        missing.append(n)
print(' '.join(missing))"#;

// ---------- Running things ----------

/// Runs a program and returns what it printed. Gives up after `timeout` and stops the program.
pub fn run_with_timeout(
    program: &str,
    args: &[String],
    timeout: Duration,
) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console window flashes
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                let mut out = String::new();
                let mut err = String::new();
                if let Some(mut s) = child.stdout.take() {
                    let _ = s.read_to_string(&mut out);
                }
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_string(&mut err);
                }
                return if status.success() {
                    Ok(out)
                } else {
                    let first = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
                    Err(format!("exited with {status}{}", if first.is_empty() { String::new() } else { format!(": {first}") }))
                };
            }
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("no answer after {} s", timeout.as_secs()));
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

fn args_for(c: &Candidate, extra: &[&str]) -> Vec<String> {
    c.args.iter().cloned().chain(extra.iter().map(|s| (*s).to_string())).collect()
}

/// Starts the candidate and reads its version.
pub fn probe(c: &Candidate) -> Result<PythonInfo, String> {
    let out = run_with_timeout(&c.program, &args_for(c, &["-c", PROBE_SCRIPT]), PROBE_TIMEOUT)?;
    parse_probe_output(&out, c)
}

fn apple_tools_installed() -> bool {
    run_with_timeout("xcode-select", &["-p".to_string()], Duration::from_secs(3)).is_ok()
}

// What the login shell finds. It reads the user's own start-up files, which is where
// Homebrew, pyenv and conda put themselves on the PATH.
fn shell_python() -> Option<String> {
    if Os::current() == Os::Windows {
        return None;
    }
    let shell = std::env::var("SHELL").ok().filter(|s| Path::new(s).is_absolute())?;
    let out = run_with_timeout(
        &shell,
        &["-lc".to_string(), "command -v python3".to_string()],
        Duration::from_secs(4),
    )
    .ok()?;
    let path = out.lines().map(str::trim).rev().find(|l| l.starts_with('/'))?.to_string();
    Path::new(&path).is_file().then_some(path)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

// ---------- The report for the interface ----------

#[derive(Debug, Serialize)]
pub struct Tried {
    pub command: String,
    /// Why it was passed over
    pub outcome: String,
}

#[derive(Debug, Serialize)]
pub struct PythonReport {
    /// "ok", "not_found", "too_old", "missing_packages" or "package_check_failed"
    pub status: &'static str,
    pub python: Option<PythonInfo>,
    /// Packages the plugin needs and Python does not have
    pub missing: Vec<String>,
    pub tried: Vec<Tried>,
    /// What to tell the user to do next
    pub hint: String,
}

fn install_hint(os: Os) -> String {
    match os {
        Os::Windows => "Install Python 3.9 or newer from python.org (tick \"Add python.exe to PATH\" or keep the py launcher), or choose the python.exe of an environment.".into(),
        Os::MacOs => "Install Python 3.9 or newer (for example with Homebrew: brew install python, or from python.org), or choose the python of an environment.".into(),
        Os::Linux => "Install Python 3.9 or newer with your package manager (for example: sudo apt install python3), or choose the python of an environment.".into(),
    }
}

/// Looks for a usable Python (the one the user chose, or the best of the usual places) and,
/// when a plugin lists `requires`, which of those packages are missing.
pub fn check_python(configured: Option<&str>, requires: &[String]) -> PythonReport {
    let os = Os::current();
    let apple_tools = os != Os::MacOs || apple_tools_installed();
    let shell = if configured.is_some_and(|c| !c.trim().is_empty()) { None } else { shell_python() };
    let list = candidates(configured, os, home_dir().as_deref(), apple_tools, shell.as_deref());

    let mut tried = Vec::new();
    let mut too_old: Option<PythonInfo> = None;
    let mut found: Option<PythonInfo> = None;
    for c in &list {
        match probe(c) {
            Ok(info) if is_supported(info.version) => {
                found = Some(info);
                break;
            }
            Ok(info) => {
                tried.push(Tried {
                    command: c.display(),
                    outcome: format!("Python {}.{}.{} is older than {}.{}", info.version.0, info.version.1, info.version.2, MIN_VERSION.0, MIN_VERSION.1),
                });
                too_old.get_or_insert(info);
            }
            Err(e) => tried.push(Tried { command: c.display(), outcome: e }),
        }
    }

    let Some(python) = found else {
        let status = if too_old.is_some() { "too_old" } else { "not_found" };
        return PythonReport { status, python: too_old, missing: vec![], tried, hint: install_hint(os) };
    };

    let names: Vec<String> = requires.iter().filter_map(|r| distribution_name(r)).collect();
    let mut missing = Vec::new();
    let mut check_error: Option<String> = None;
    if !names.is_empty() {
        let mut args = args_for(&python.command, &["-c", MISSING_SCRIPT]);
        args.extend(names.iter().cloned());
        match run_with_timeout(&python.command.program, &args, PROBE_TIMEOUT) {
            Ok(out) => missing = out.split_whitespace().map(str::to_string).collect(),
            Err(e) => check_error = Some(e),
        }
    }
    let (status, hint) = if let Some(e) = check_error {
        ("package_check_failed", format!("Python was found, but its packages could not be checked: {e}"))
    } else if missing.is_empty() {
        ("ok", String::new())
    } else {
        (
            "missing_packages",
            format!("{} -m pip install {}", python.executable_or_command(), missing.join(" ")),
        )
    };
    PythonReport { status, python: Some(python), missing, tried, hint }
}

impl PythonInfo {
    // What to type to run this Python in a terminal
    fn executable_or_command(&self) -> String {
        if self.executable.is_empty() { self.command.display() } else { self.executable.clone() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(p: &str) -> Candidate {
        Candidate::new(p, &[])
    }

    #[test]
    fn the_answer_of_python_is_read() {
        let c = cmd("python3");
        let info = parse_probe_output("3 12 4\n/usr/bin/python3\n", &c).unwrap();
        assert_eq!(info.version, (3, 12, 4));
        assert_eq!(info.executable, "/usr/bin/python3");
        assert!(parse_probe_output("", &c).is_err());
        assert!(parse_probe_output("Python is not installed", &c).is_err());
        assert!(parse_probe_output("3 12\n/x", &c).is_err());
        assert!(parse_probe_output("3 x 4\n/x", &c).is_err());
    }

    #[test]
    fn versions_below_the_minimum_are_refused() {
        assert!(is_supported((3, 9, 0)));
        assert!(is_supported((3, 13, 1)));
        assert!(is_supported((4, 0, 0)));
        assert!(!is_supported((3, 8, 18)));
        assert!(!is_supported((2, 7, 18)));
    }

    #[test]
    fn a_chosen_python_is_never_replaced() {
        let list = candidates(Some(" /my/venv/bin/python "), Os::MacOs, None, true, Some("/opt/x"));
        assert_eq!(list, vec![cmd("/my/venv/bin/python")]);
        // An empty choice means no choice
        assert!(candidates(Some("  "), Os::Linux, None, true, None).len() > 1);
    }

    #[test]
    fn windows_asks_the_launcher_first() {
        let list = candidates(None, Os::Windows, Some(Path::new("C:\\Users\\me")), true, None);
        assert_eq!(list[0], Candidate::new("py", &["-3"]));
        assert_eq!(list[1], cmd("python"));
        assert!(list.iter().any(|c| c.program.ends_with("miniconda3\\python.exe")));
    }

    #[test]
    fn the_macos_stub_is_left_out_without_the_command_line_tools() {
        let home = Some(Path::new("/Users/me"));
        let without = candidates(None, Os::MacOs, home, false, None);
        assert!(!without.contains(&cmd("python3")));
        assert!(!without.contains(&cmd("/usr/bin/python3")));
        assert!(without.contains(&cmd("/opt/homebrew/bin/python3")));
        let with = candidates(None, Os::MacOs, home, true, None);
        assert!(with.contains(&cmd("/usr/bin/python3")));
        // Homebrew and the like come before the system Python
        let pos = |p: &str| with.iter().position(|c| c.program == p).unwrap();
        assert!(pos("/opt/homebrew/bin/python3") < pos("/usr/bin/python3"));
        assert!(pos("/Users/me/.pyenv/shims/python3") < pos("python3"));
    }

    #[test]
    fn the_login_shell_answer_comes_first_and_nothing_is_listed_twice() {
        let list = candidates(None, Os::MacOs, None, true, Some("/opt/homebrew/bin/python3"));
        assert_eq!(list[0], cmd("/opt/homebrew/bin/python3"));
        assert_eq!(list.iter().filter(|c| c.program == "/opt/homebrew/bin/python3").count(), 1);
        let linux = candidates(None, Os::Linux, None, true, None);
        assert_eq!(linux[0], cmd("python3"));
        assert_eq!(linux[1], cmd("python"));
    }

    #[test]
    fn requirements_become_plain_names_or_nothing() {
        assert_eq!(distribution_name("numpy").as_deref(), Some("numpy"));
        assert_eq!(distribution_name("numpy>=1.20").as_deref(), Some("numpy"));
        assert_eq!(distribution_name("scikit-image[extra]").as_deref(), Some("scikit-image"));
        assert_eq!(distribution_name("a.b_c-d == 2.*").as_deref(), Some("a.b_c-d"));
        assert_eq!(distribution_name("pkg; python_version<'3.8'").as_deref(), Some("pkg"));
        // Things that are not names are dropped
        assert_eq!(distribution_name("").as_deref(), None);
        assert_eq!(distribution_name("-e ."), None);
        assert_eq!(distribution_name("$(rm -rf ~)"), None);
        assert_eq!(distribution_name("x`y`"), None);
        assert_eq!(distribution_name("../evil"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_program_that_does_not_answer_is_stopped() {
        let started = Instant::now();
        let err = run_with_timeout("sleep", &["5".to_string()], Duration::from_millis(200)).unwrap_err();
        assert!(err.contains("no answer"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(2));
        // A program that fails reports why
        let err = run_with_timeout("sh", &["-c".into(), "echo broken >&2; exit 3".into()], Duration::from_secs(2)).unwrap_err();
        assert!(err.contains("broken"), "{err}");
        // One that does not exist reports that
        assert!(run_with_timeout("no-such-program-xyz", &[], Duration::from_secs(1)).is_err());
    }

    #[test]
    fn a_configured_path_that_is_not_python_is_reported() {
        let report = check_python(Some("/definitely/not/python"), &[]);
        assert_eq!(report.status, "not_found");
        assert_eq!(report.tried.len(), 1);
        assert!(!report.hint.is_empty());
    }

    // These need a Python on the machine; without one they check nothing
    #[test]
    fn a_real_python_is_found_and_missing_packages_are_listed() {
        let report = check_python(None, &["definitely-not-installed-xyz".to_string(), "$(bad)".to_string()]);
        if let Some(py) = &report.python {
            assert!(py.version.0 >= 3);
            if is_supported(py.version) {
                assert_eq!(report.status, "missing_packages");
                assert_eq!(report.missing, vec!["definitely-not-installed-xyz".to_string()]);
                assert!(report.hint.contains("pip install definitely-not-installed-xyz"));
                // Nothing is missing when nothing is asked for
                assert_eq!(check_python(None, &[]).status, "ok");
            }
        }
    }
}