//! In-process agent runtimes for AgentZ.
//!
//! [`koi::DesktopInProcessSubagentRuntime`] implements the kernel
//! [`piscis_core::host::SubagentRuntime`] contract by running Koi turns inside
//! the already-running Tauri process (no subprocess / headless binary). It is
//! injected into the kernel pool coordinator so team (Pool) collaboration fans
//! out to member Koi without leaving the desktop process.

pub mod koi;
pub mod patrol;
pub mod workflow;
