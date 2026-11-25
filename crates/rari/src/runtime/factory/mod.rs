pub(crate) mod component_ops;
mod create_params;
mod executor;
mod interface;
pub mod pool;
mod runtime;
mod runtime_builder;
pub(crate) mod utils;

#[cfg(test)]
use std::cell::Cell;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

pub use interface::JsRuntimeInterface;
pub use pool::{
    JsRuntimePool, LeasedRequestRuntime, PooledRuntime, PostRebuildHook, StreamingSlotGuard,
};
pub use runtime::RariRuntime;
use rustc_hash::FxHashMap;

static V8_RUNTIME_INIT_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
std::thread_local! {
    static V8_RUNTIME_INIT_HELD: Cell<bool> = const { Cell::new(false) };
}

pub(crate) struct V8RuntimeInitGuard {
    _guard: MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for V8RuntimeInitGuard {
    fn drop(&mut self) {
        V8_RUNTIME_INIT_HELD.with(|held| held.set(false));
    }
}

// V8 snapshot deserialization uses shared heap state across isolate creation.
pub(crate) fn lock_v8_runtime_init() -> V8RuntimeInitGuard {
    let guard = V8_RUNTIME_INIT_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    #[cfg(test)]
    V8_RUNTIME_INIT_HELD.with(|held| held.set(true));
    V8RuntimeInitGuard { _guard: guard }
}

#[cfg(test)]
pub(crate) fn v8_runtime_init_held_by_current_thread() -> bool {
    V8_RUNTIME_INIT_HELD.with(Cell::get)
}

pub fn create_runtime() -> Arc<RariRuntime> {
    Arc::new(RariRuntime::new(None))
}

#[expect(
    clippy::implicit_hasher,
    reason = "FxHashMap is the specific hasher needed for runtime env vars"
)]
pub fn create_runtime_with_env(env_vars: FxHashMap<String, String>) -> Arc<RariRuntime> {
    Arc::new(RariRuntime::new(Some(env_vars)))
}

#[cfg(test)]
mod tests {
    use super::{V8_RUNTIME_INIT_LOCK, lock_v8_runtime_init};

    #[test]
    fn v8_runtime_init_lock_excludes_other_initializers() {
        let _guard = lock_v8_runtime_init();
        assert!(V8_RUNTIME_INIT_LOCK.try_lock().is_err());
    }
}
