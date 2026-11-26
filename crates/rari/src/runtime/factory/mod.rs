pub(crate) mod component_ops;
mod create_params;
mod executor;
mod interface;
pub mod pool;
mod runtime;
mod runtime_builder;
pub(crate) mod utils;

use std::sync::{Arc, Mutex, MutexGuard};
#[cfg(test)]
use std::{cell::Cell, thread_local};

pub use interface::JsRuntimeInterface;
pub use pool::{
    JsRuntimePool, LeasedRequestRuntime, PooledRuntime, PostRebuildHook, StreamingSlotGuard,
};
pub use runtime::RariRuntime;
#[cfg(test)]
pub(crate) use runtime_builder::initialize_js_runtime;
use rustc_hash::FxHashMap;

static V8_RUNTIME_INIT_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
thread_local! {
    static V8_RUNTIME_INIT_HELD_BY_CURRENT_THREAD: Cell<bool> = const { Cell::new(false) };
}

pub(crate) struct V8RuntimeInitGuard {
    _guard: MutexGuard<'static, ()>,
}

// V8 snapshot deserialization uses shared heap state across isolate creation.
pub(crate) fn lock_v8_runtime_init() -> V8RuntimeInitGuard {
    let guard = match V8_RUNTIME_INIT_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            tracing::warn!("V8 runtime init lock was poisoned; recovering the guard");
            poisoned.into_inner()
        }
    };
    #[cfg(test)]
    V8_RUNTIME_INIT_HELD_BY_CURRENT_THREAD.with(|held| held.set(true));
    V8RuntimeInitGuard { _guard: guard }
}

#[cfg(test)]
fn v8_runtime_init_held_by_current_thread() -> bool {
    V8_RUNTIME_INIT_HELD_BY_CURRENT_THREAD.with(Cell::get)
}

#[cfg(test)]
pub(super) fn assert_v8_runtime_init_held_by_current_thread() {
    assert!(
        v8_runtime_init_held_by_current_thread(),
        "JsRuntime::new must run under the shared init lock on this thread"
    );
}

#[cfg(test)]
impl Drop for V8RuntimeInitGuard {
    fn drop(&mut self) {
        #[cfg(test)]
        V8_RUNTIME_INIT_HELD_BY_CURRENT_THREAD.with(|held| held.set(false));
    }
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
    use std::{sync::TryLockError, thread};

    use super::{
        V8_RUNTIME_INIT_LOCK, assert_v8_runtime_init_held_by_current_thread, lock_v8_runtime_init,
        v8_runtime_init_held_by_current_thread,
    };

    #[test]
    fn v8_runtime_init_lock_excludes_other_initializers() {
        let _guard = lock_v8_runtime_init();
        assert!(matches!(V8_RUNTIME_INIT_LOCK.try_lock(), Err(TryLockError::WouldBlock)));
    }

    #[test]
    #[should_panic(expected = "JsRuntime::new must run under the shared init lock on this thread")]
    fn constructor_guard_assertion_detects_early_release() {
        let guard = lock_v8_runtime_init();
        drop(guard);
        assert_v8_runtime_init_held_by_current_thread();
    }

    #[test]
    #[expect(
        clippy::expect_used,
        reason = "The ownership probe thread must finish for this regression test"
    )]
    fn v8_runtime_init_guard_is_tracked_per_thread() {
        let guard = lock_v8_runtime_init();
        assert!(v8_runtime_init_held_by_current_thread());
        assert!(
            !thread::spawn(v8_runtime_init_held_by_current_thread)
                .join()
                .expect("ownership probe thread should finish")
        );
        drop(guard);
        assert!(!v8_runtime_init_held_by_current_thread());
    }
}
