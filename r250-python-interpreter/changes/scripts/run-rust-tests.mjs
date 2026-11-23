#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync, spawn as spawnStreaming} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const cargoRoot=path.join(root,'src-tauri');
const targetRoot=path.resolve(process.env.CARGO_TARGET_DIR??path.join(cargoRoot,'target'));
const rustTestLog=path.join(targetRoot,'v20-rust-tests-last.log');
const extraArguments=process.argv.slice(2);
const buildId=fs.readFileSync(path.join(root,'RELEASE-BUILD-ID.txt'),'utf8').trim();
if(!/^[A-Z0-9][A-Z0-9._-]{7,95}$/.test(buildId))throw new Error('RELEASE-BUILD-ID.txt is malformed');
console.log(`Rust native verification build ID: ${buildId}`);

// The offline_voice process and warm-worker tests execute a real interpreter and read its path from
// KF_TEST_PYTHON. Unset, they fail with a bare expect() panic that reads like a broken test rather
// than a missing prerequisite, so resolve the interpreter once here and hand it to every cargo call.
const probeInterpreter=command=>{
  const result=spawnSync(command,['-c','import sys; print(sys.executable)'],{
    encoding:'utf8',shell:false,stdio:['ignore','pipe','pipe'],
  });
  if(result.error||result.status!==0)return null;
  const lines=(result.stdout??'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  return lines.at(-1)??null;
};
const interpreterRuns=command=>{
  const result=spawnSync(command,['-c','import sys'],{shell:false,stdio:'ignore'});
  return !result.error&&result.status===0;
};
const resolveTestPython=()=>{
  const configured=process.env.KF_TEST_PYTHON?.trim();
  if(configured){
    if(!interpreterRuns(configured))throw new Error(`KF_TEST_PYTHON is set but does not run: ${configured}`);
    return {interpreter:configured,source:'KF_TEST_PYTHON'};
  }
  // `py -3` is the reliable Windows launcher; a bare `python` there can be the Store alias.
  const candidates=process.platform==='win32'
    ?[['py',['-3']],['python',[]],['python3',[]]]
    :[['python3',[]],['python',[]]];
  for(const [command,prefix] of candidates){
    const interpreter=probeInterpreter(command);
    if(!interpreter||!interpreterRuns(interpreter))continue;
    return {interpreter,source:prefix.length?`${command} ${prefix.join(' ')}`:command};
  }
  return null;
};
const testPython=resolveTestPython();
if(!testPython){
  process.stderr.write('KF_TEST_PYTHON is not set and no usable Python 3 interpreter was found on PATH.\n');
  process.stderr.write('The offline_voice process and warm-worker tests execute a real interpreter, so they cannot be verified without one.\n');
  process.stderr.write('Install Python 3 or point KF_TEST_PYTHON at an interpreter.\n');
  process.exit(1);
}
console.log(`Rust test Python interpreter: ${testPython.interpreter} (resolved from ${testPython.source})`);
const testEnv={...process.env,KF_TEST_PYTHON:testPython.interpreter,CARGO_TERM_COLOR:'never'};

const MIN_ROOT_TEST_COUNT=process.platform==='win32'?129:127;
const requiredRootTests=[
  'transactional_core::temperature::tests::temperature_accepts_finite_numeric_json_and_vendor_strings',
  'transactional_core::temperature::tests::temperature_rejects_absent_malformed_and_nonfinite_readings',
  'transactional_core::temperature::tests::temperature_core_freshness_requires_both_observations_and_uses_older_one',
  'transactional_core::types::tests::temperature_legacy_actor_wire_fields_do_not_invent_provenance',
  'transactional_core::actor::tests::temperature_numeric_strings_advance_only_actual_core_freshness',
  'transactional_core::actor::tests::temperature_partial_heater_delta_keeps_other_heater_provenance',
  'transactional_core::actor::tests::temperature_repair_restores_heaters_after_job_only_grouped_reply',
  'transactional_core::actor::tests::temperature_repair_uses_alternate_transport_for_still_missing_heater',
  'transactional_core::actor::tests::temperature_repair_failure_keeps_stale_readings_and_freshness_honest',
  'transactional_core::instance_lease::tests::instance_focus_waits_for_mutex_lease_publication',
  'transactional_core::instance_lease::tests::instance_focus_waits_past_old_half_second_ack_limit',
  'transactional_core::instance_lease::tests::instance_focus_never_accepts_an_unconfirmed_ack',
  'transactional_core::instance_lease::tests::instance_focus_ack_has_an_absolute_deadline',
  'transactional_core::instance_lease::tests::instance_focus_stops_waiting_when_mutex_owner_exits',
  'transactional_core::instance_lease::tests::instance_focus_missing_lease_has_a_bounded_startup_grace',
  'transactional_core::instance_lease::tests::instance_focus_normal_first_launch_does_not_wait_for_a_lease',
  'transactional_core::instance_lease::tests::instance_focus_refused_stale_lease_does_not_wait_for_startup_grace',
  'creality_light::tests::creality_light_parser_accepts_only_binary_numeric_root_state',
  'creality_light::tests::creality_light_poll_uses_fixed_path_and_real_state',
  'creality_light::tests::creality_light_write_discards_prewrite_and_requires_later_matching_state',
  'creality_light::tests::creality_light_ack_without_readback_fails_without_command_replay',
  'creality_light::tests::creality_light_does_not_write_when_initial_state_is_missing',
  'creality_light::tests::creality_light_supports_ping_heartbeat_and_fragmented_state',
  'creality_light::tests::creality_light_matching_initial_state_is_not_write_confirmation',
  'creality_light::tests::creality_light_rejects_malformed_and_oversize_frames',
  'creality_light::tests::creality_light_absolute_deadline_stops_trickled_payload',
  'creality_light::tests::creality_light_absolute_deadline_stops_trickled_upgrade',
  'login_method_tests::pin_only_setup_cannot_be_reset_by_another_bootstrap',
  'login_method_tests::legacy_password_setup_remains_configured',
  'login_method_tests::hello_grant_is_bound_to_account_version_and_current_credentials',
  'login_method_tests::hello_single_flight_releases_after_failure',
  'login_method_tests::pin_removal_cannot_remove_the_only_login_method',
  'transactional_core::actor::tests::accepted_start_requires_fresh_matching_job_and_is_never_repeated',
  'transactional_core::upload::upload_response_tests::upload_refusal_keeps_the_server_reason_and_bounds_it',
  'transactional_core::upload::tests::legacy_remote_verified_record_keeps_original_filename_and_local_staging',
  'transactional_core::upload::tests::fresh_begin_restarts_completed_upload_without_reusing_cached_remote_path',
  'tests::moonraker_file_move_has_safe_rest_fallback',
  'online_updates::tests::routine_offline_queries_do_not_block_but_pending_mutations_do',
  ...(process.platform==='win32'?['desktop_job::tests::job_close_stops_only_the_owned_child']:[]),
  'engine_client::tests::shutdown_prevents_late_startup_recovery_and_embedded_fallback',
  'online_updates::tests::disconnected_or_expired_cached_print_does_not_block_update',
  'online_updates::tests::install_is_deferred_for_printing_paused_or_active_transfer',
  'update_cache::tests::completed_partial_and_abandoned_updates_are_removed_but_prepared_and_active_are_kept',
  'update_cache::tests::unrelated_files_directories_and_external_paths_are_never_removed',
  'update_cache::tests::cache_links_are_not_followed',
  'engine_client::tests::upload_finish_waits_past_short_ipc_deadline_without_replay',
  'engine_client::tests::daemon_recovery_retries_only_idempotent_or_read_only_commands',
  'engine_client::tests::owner_conflict_retry_is_narrowly_classified',
  'engine_client::tests::only_local_ipc_transport_failures_trigger_daemon_recovery',
  'engine_client::tests::settled_startup_failure_allows_single_owner_embedded_failover',
  'engine_client::tests::embedded_core_cannot_race_daemon_startup_or_ready_state',
  'engine_client::tests::startup_error_detail_is_bounded_and_redacts_credentials',
  'headless_engine::tests::headless_daemon_serves_authenticated_health_and_shutdown',
  'headless_engine::tests::crash_left_endpoint_is_retired_before_rebinding_the_socket',
  'headless_engine::tests::ipc_probe_schema_is_strict_and_never_accepts_a_caller_token',
  'headless_engine::tests::long_data_directory_uses_a_short_private_socket_path',
  'transactional_core::backup::tests::online_backup_is_verified_and_rotated',
  'transactional_core::backup::tests::restore_drill_reopens_a_copy_and_records_evidence',
  'transactional_core::migrations::tests::v20_migration_creates_online_backup_before_schema_change',
  'transactional_core::migrations::tests::current_schema_is_not_migrated_or_registered_again',
  'transactional_core::durable_fs::tests::existing_file_is_flushed_without_truncation',
  'transactional_core::durable_fs::tests::atomic_rename_publishes_exact_contents',
  'transactional_core::actor::tests::headless_status_is_recoverable_from_shared_snapshot_without_live_event_sink',
  'transactional_core::actor::tests::headless_actor_physically_receives_websocket_telemetry',
  'transactional_core::actor::tests::disconnected_headless_actor_physically_uses_rest_compatibility_rpc',
  'transactional_core::discovery::tests::arp_output_keeps_only_unique_local_ipv4_hosts',
  'transactional_core::discovery::tests::manual_host_checks_both_standard_ports',
  'transactional_core::discovery::tests::seed_routes_bind_matching_physical_adapter',
  'transactional_core::discovery::tests::seed_dedupe_preserves_same_target_on_distinct_adapters',
  'transactional_core::actor::tests::authorization_failures_are_classified_for_slow_reconnect',
  'transactional_core::actor::tests::stale_connection_observation_has_bounded_reconnect_deadline',
  'transactional_core::actor::tests::actor_reconfigure_ack_is_nonblocking_while_worker_is_busy',
  'transactional_core::actor::tests::only_transient_attestation_quarantine_is_automatically_retried',
  'transactional_core::identity::tests::legacy_config_identity_survives_missing_optional_hardware_signals',
  'transactional_core::identity::tests::enforced_hardware_identity_still_requires_proof',
  'transactional_core::identity::tests::optional_lower_priority_signals_do_not_rotate_stable_id',
  'transactional_core::capabilities::tests::missing_object_catalog_does_not_prove_incompatibility',
  'transactional_core::capabilities::tests::confirmed_incomplete_catalog_remains_quarantinable',
  'transactional_core::tests::durable_actor_registry_round_trips_replaces_and_deletes_without_secrets',
  'transactional_core::types::tests::actor_presentation_keeps_reason_channel_and_data_age_together',
  'transactional_core::types::tests::connected_quarantine_does_not_lie_about_network_reachability',
  'tests::moonraker_server_info_is_found_twenty_times_without_a_miss',
  'tests::complete_24_fast_pass_stays_below_eight_seconds',
  'tests::discovery_dedup_matches_uuid_and_hostname_after_ip_change',
  'tests::discovery_dedup_refuses_same_ip_with_different_uuid',
  'tests::discovery_dedup_prefers_matching_uuid_over_local_saved_ids',
  'tests::source_bound_tcp_rejects_mixed_address_families_before_connecting',
  'tests::source_bound_tcp_connects_through_the_requested_adapter_address',
  'tests::windows_sid_parser_accepts_unicode_account_names_without_trusting_them',
  'tests::access_or_credential_change_revokes_every_user_session',
];
if(process.platform==='win32')requiredRootTests.push(
  'engine_client::tests::recorded_daemon_image_parser_accepts_only_product_sidecars',
  'transactional_core::engine_lease::tests::windows_named_mutex_probe_observes_owner_and_release',
);
const baseArguments=['test','--offline','--locked','--workspace','--all-targets','--features','fault-injection',...extraArguments];
const spawn=(command,args,options={})=>{
  const result=spawnSync(command,args,{
    cwd:options.cwd??cargoRoot,
    stdio:options.stdio??'inherit',
    shell:false,
    encoding:options.encoding,
    maxBuffer:options.maxBuffer,
    env:options.env??process.env,
  });
  if(result.error)throw result.error;
  return result;
};
const run=(command,args,options={})=>spawn(command,args,options).status??1;
const targetCleanArguments=()=>{
  const arguments_=[];
  for(let index=0;index<extraArguments.length;index+=1){
    const value=extraArguments[index];
    if(value==='--target'&&extraArguments[index+1]){
      arguments_.push('--target',extraArguments[index+1]);
      index+=1;
    }else if(value.startsWith('--target=')){
      arguments_.push(value);
    }
  }
  return arguments_;
};

if(process.platform==='win32'){
  // ZIP entries use deterministic release timestamps. If a newer archive is
  // extracted over an older failed build, Cargo's mtime fast path can otherwise
  // execute yesterday's root test binary. Rebuild only the application package;
  // verified third-party dependencies remain cached.
  // A fingerprint reset can leave an empty target without the cache-dir tag;
  // Cargo 1.84+ refuses to clean such a directory, so restore the tag first.
  fs.mkdirSync(targetRoot,{recursive:true});
  const cacheDirTagPath=path.join(targetRoot,'CACHEDIR.TAG');
  if(!fs.existsSync(cacheDirTagPath))fs.writeFileSync(cacheDirTagPath,'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n# For information about cache directory tags, see:\n#\thttp://www.brynosaurus.com/cachedir/\n');
  const cleanStatus=run('cargo',['clean','-p','klipper-farm-client',...targetCleanArguments()]);
  if(cleanStatus!==0)process.exit(cleanStatus);

  fs.mkdirSync(targetRoot,{recursive:true});
  const artifactLog=path.join(targetRoot,'v20-windows-test-artifacts.jsonl');
  if(fs.existsSync(artifactLog)&&fs.lstatSync(artifactLog).isSymbolicLink())throw new Error('Refusing a symlinked Cargo artifact log');
  const descriptor=fs.openSync(artifactLog,'w',0o600);
  let compileStatus;
  try{
    compileStatus=run('cargo',[...baseArguments,'--no-run','--message-format=json-diagnostic-rendered-ansi'],{stdio:['inherit',descriptor,'inherit']});
  }finally{
    fs.closeSync(descriptor);
  }
  if(compileStatus!==0){
    for(const line of fs.readFileSync(artifactLog,'utf8').split(/\r?\n/)){
      if(!line)continue;
      try{
        const message=JSON.parse(line);
        if(message.reason==='compiler-message'&&message.message?.rendered)process.stderr.write(message.message.rendered);
      }catch{}
    }
    process.exit(compileStatus);
  }
  const loaderStatus=run(process.execPath,[path.join(root,'scripts','check-windows-test-loader.mjs'),artifactLog],{cwd:root});
  if(loaderStatus!==0)process.exit(loaderStatus);
}

const inventory=spawn('cargo',[
  'test','--offline','--locked','-p','klipper-farm-client','--lib','--features','fault-injection',
  ...extraArguments,'--','--list',
],{
  stdio:['ignore','pipe','pipe'],
  encoding:'utf8',
  maxBuffer:8*1024*1024,
  env:testEnv,
});
if(inventory.status!==0){
  process.stdout.write(inventory.stdout??'');
  process.stderr.write(inventory.stderr??'');
  process.exit(inventory.status??1);
}
const rootTests=(inventory.stdout??'')
  .split(/\r?\n/)
  .map(line=>line.match(/^(.+): test$/)?.[1])
  .filter(Boolean);
if(rootTests.length<MIN_ROOT_TEST_COUNT){
  process.stderr.write(`STALE_OR_INCOMPLETE_RUST_TEST_BINARY: expected at least ${MIN_ROOT_TEST_COUNT} current root tests, found ${rootTests.length}.\n`);
  process.exit(1);
}
for(const required of requiredRootTests){
  if(!rootTests.includes(required)){
    process.stderr.write(`STALE_OR_INCOMPLETE_RUST_TEST_BINARY: missing ${required}.\n`);
    process.exit(1);
  }
}
console.log(`Rust test inventory OK: ${rootTests.length} current root tests (minimum ${MIN_ROOT_TEST_COUNT}); all critical regressions present.`);

// Stream native test progress immediately while retaining complete evidence.
const spawnLogged=(command,args,options={})=>new Promise((resolve,reject)=>{
  const child=spawnStreaming(command,args,{
    cwd:options.cwd??cargoRoot, shell:false,
    stdio:['inherit','pipe','pipe'], env:options.env??process.env,
  });
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdout+=chunk;process.stdout.write(chunk);});
  child.stderr.on('data',chunk=>{stderr+=chunk;process.stderr.write(chunk);});
  child.once('error',reject);
  child.once('close',status=>resolve({status,stdout,stderr}));
});
const finalArguments=process.platform==='win32'?[...baseArguments,'--','--test-threads=1']:baseArguments;
if(process.platform==='win32'){
  const result=await spawnLogged('cargo',finalArguments,{
    stdio:['inherit','pipe','pipe'],
    encoding:'utf8',
    maxBuffer:64*1024*1024,
    env:testEnv,
  });
  const combined=`${result.stdout??''}\n${result.stderr??''}`;
  fs.mkdirSync(targetRoot,{recursive:true});
  fs.writeFileSync(rustTestLog,combined,'utf8');
  if(result.status!==0){
    const failures=[...combined.matchAll(/^test (.+) \.\.\. FAILED\s*$/gm)].map(match=>match[1]);
    process.stderr.write(`\nRust failing tests: ${failures.length?failures.join(', '):'see complete log'}\n`);
    process.stderr.write(`Complete Rust test log: ${rustTestLog}\n`);
  }
  process.exit(result.status??1);
}
process.exit(run('cargo',finalArguments,{env:testEnv}));
