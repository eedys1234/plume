// Windows 릴리스 빌드에서 콘솔 창이 뜨지 않도록.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    api_generator_lib::run()
}
