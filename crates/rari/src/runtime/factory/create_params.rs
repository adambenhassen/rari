use std::sync::Once;

use deno_core::{
    JsRuntime, RuntimeOptions,
    v8::{CreateParams, V8, cppgc},
};

#[cfg(test)]
use crate::runtime::factory::v8_runtime_init_held_by_current_thread;

static V8_READY: Once = Once::new();

pub fn runtime_create_params() -> CreateParams {
    #[cfg(test)]
    assert!(
        v8_runtime_init_held_by_current_thread(),
        "runtime create params must be initialized under the shared lock on this thread"
    );

    V8_READY.call_once(|| {
        let _ = JsRuntime::new(RuntimeOptions { extensions: vec![], ..Default::default() });
    });

    let platform = V8::get_current_platform();
    let heap = cppgc::Heap::create(platform, cppgc::HeapCreateParams::default());
    CreateParams::default().cpp_heap(heap)
}
