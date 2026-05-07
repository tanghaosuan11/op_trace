use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

pub mod op_trace;
mod optrace_journal;
mod analysis;
mod sourcify;
pub mod scripts_fs;
pub mod commands;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use scripts_fs::{
    delete_analysis_script_path,
    list_analysis_scripts,
    mkdir_analysis_script_dir,
    read_analysis_script,
    rename_analysis_script_path,
    write_analysis_script,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(op_trace::DebugSessionState(Arc::new(Mutex::new(HashMap::new()))))
        .manage(commands::AnalysisCancelFlags(Arc::new(Mutex::new(HashMap::new()))))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::debug::greet,
            commands::debug::op_trace,
            commands::debug::seek_to,
            commands::debug::range_full_data,
            commands::debug::find_value_origin,
            commands::debug::reset_session,
            commands::analysis_cmd::scan_conditions,
            commands::analysis_cmd::run_analysis,
            commands::analysis_cmd::cancel_analysis,
            commands::shadow::backward_slice_tree,
            commands::shadow::debug_shadow_steps,
            commands::shadow::export_all_shadow_steps,
            commands::shadow::validate_shadow_steps,
            commands::fork::validate_fork_patch,
            commands::cfg::build_cfg,
            commands::symbolic::symbolic_solve,
            commands::symbolic::symbolic_slice,
            commands::symbolic::symbolic_auto_solve,
            commands::symbolic::symbolic_verify,
            commands::decompile::decompile_frame_cmd,
            commands::data::fetch_address_labels,
            commands::data::open_app_data_dir,
            commands::data::save_data,
            list_analysis_scripts,
            read_analysis_script,
            write_analysis_script,
            mkdir_analysis_script_dir,
            delete_analysis_script_path,
            rename_analysis_script_path,
            sourcify::sourcify_read_cache,
            sourcify::sourcify_write_cache,
            sourcify::decompile_read_cache,
            sourcify::decompile_write_cache,
            sourcify::decompile_bytecode,
            commands::foundry::start_foundry_debug,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
