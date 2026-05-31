//! CodeZ host shell — bootstrap skeleton.
//!
//! CodeZ is a Cursor-like AI IDE with two first-class modes (IDE / Agent)
//! built on the shared `pisci-engine` agent kernel. This binary is the seed
//! of the host: for now it just links the kernel and prints a banner, which
//! proves the engine dependency resolves and compiles end to end. The Tauri
//! UI shell, the IDE/Agent harness presets and the new `edit` / `index` /
//! `agent_task` modules layer on top of this crate over the milestones in
//! `docs/codez-design.md`.

fn main() {
    println!("CodeZ host — Cursor-like AI IDE on the pisci-engine kernel");
    println!("kernel version: {}", pisci_kernel::KERNEL_VERSION);

    // Touch the contracts crate so the host↔kernel boundary is real and
    // linked from day one. Hosts implement these traits to inject UI,
    // secrets and platform tools into the kernel.
    let _trait_check = describe_host_contract();
    println!("host contract: {_trait_check}");
}

/// Names the `pisci-core` host trait this skeleton will implement first.
fn describe_host_contract() -> &'static str {
    // `pisci_core` is re-exported by the kernel as `pisci_kernel::core`, but
    // we depend on it directly to make the intent explicit.
    let _ = std::marker::PhantomData::<pisci_core::host::ToolRegistryHandle>;
    "pisci_core::host::HostRuntime (EventSink + Notifier + HostTools + SecretsStore)"
}
