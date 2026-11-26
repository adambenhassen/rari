use std::sync::Once;

use deno_core::{
    JsRuntime, RuntimeOptions,
    v8::{CreateParams, V8, cppgc},
};

use crate::runtime::factory::V8RuntimeInitGuard;

static V8_READY: Once = Once::new();

pub fn runtime_create_params(_init_guard: &V8RuntimeInitGuard) -> CreateParams {
    V8_READY.call_once(|| {
        let _ = JsRuntime::new(RuntimeOptions { extensions: vec![], ..Default::default() });
    });

    let platform = V8::get_current_platform();
    let heap = cppgc::Heap::create(platform, cppgc::HeapCreateParams::default());
    CreateParams::default().cpp_heap(heap)
}
