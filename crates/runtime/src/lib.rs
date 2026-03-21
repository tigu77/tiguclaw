//! tiguclaw-runtime: RuntimeAdapter implementations.

pub mod native;
pub mod dummy;

pub use native::NativeRuntime;
pub use dummy::DummyRuntime;
