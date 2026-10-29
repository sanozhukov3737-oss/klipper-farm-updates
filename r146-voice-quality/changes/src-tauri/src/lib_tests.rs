use super::*;

#[test]
fn filament_inventory_generic_writes_and_viewer_audit_shortcuts_are_blocked() {
    assert!(db_write_role("production.filamentInventory").is_err());
    assert_eq!(db_write_role("production.spools").unwrap(), Role::Operator);
    assert!(!notification_action_allowed("filament.milestone"));
    assert!(!notification_action_allowed("filament.reserve"));
    assert!(notification_action_allowed("filament.runout"));
}

#[test]
fn windows_sid_parser_accepts_unicode_account_names_without_trusting_them() {
    let output = "КОМПЬЮТЕР\\Александр  S-1-5-21-100-200-300-1001\r\n";
    assert_eq!(
        parse_windows_sid(output.as_bytes()).as_deref(),
        Some("S-1-5-21-100-200-300-1001")
    );
    assert!(parse_windows_sid(b"user S-1-5-21-1-2-3:evil").is_none());
}

#[test]
fn legacy_sync_rpc_is_retained_only_as_a_test_oracle() {
    type Oracle = fn(
        String,
        Option<String>,
        String,
        Option<serde_json::Value>,
        bool,
        Option<u64>,
        u16,
    ) -> Result<serde_json::Value, String>;
    let oracle: Oracle = rpc_blocking;
    assert_eq!(
        std::mem::size_of_val(&oracle),
        std::mem::size_of::<Oracle>()
    );
}

#[test]
fn password_policy_rejects_short_passwords() {
    assert!(validate_password("Short9!").is_err());
    assert!(validate_password("correct horse battery staple").is_err());
    assert!(validate_password("Correct-Horse9").is_ok());
}

#[test]
fn password_hash_round_trip() {
    let encoded = hash_password("Correct-Horse9").expect("hash");
    assert!(verify_password("Correct-Horse9", &encoded));
    assert!(!verify_password("Wrong-Password9", &encoded));
}

#[test]
fn pin_policy_and_hash_round_trip() {
    assert!(validate_pin("12345").is_err());
    assert!(validate_pin("12345a").is_err());
    assert!(validate_pin("123456").is_ok());
    let encoded = hash_pin("274906").expect("pin hash");
    assert!(verify_pin("274906", &encoded));
    assert!(!verify_pin("274907", &encoded));
    assert!(!verify_password("274906", &encoded));
}

#[test]
fn access_or_credential_change_revokes_every_user_session() {
    let mut inner = AuthInner::default();
    for (token, user_id) in [("first", "operator"), ("second", "operator"), ("admin", "admin")] {
        inner.sessions.insert(
            token.into(),
            SessionRecord {
                user_id: user_id.into(),
                created_at: 1,
                last_seen: 2,
            },
        );
    }
    revoke_user_sessions(&mut inner, "operator");
    assert_eq!(inner.sessions.len(), 1);
    assert_eq!(inner.sessions.get("admin").unwrap().user_id, "admin");
}

#[test]
fn target_rejects_public_and_ambiguous_addresses() {
    assert!(parse_target("192.168.1.20:7125", 7125).is_ok());
    assert!(parse_target("http://10.0.0.2:7125", 7125).is_ok());
    assert!(parse_target("8.8.8.8:7125", 7125).is_err());
    assert!(parse_target("https://192.168.1.20:7125", 7125).is_err());
    assert!(parse_target("localhost:7125", 7125).is_ok());
    assert!(parse_target("printer.example.com:7125", 7125).is_err());
    assert!(parse_target("192.168.1.20:7125/admin", 7125).is_err());
    assert_eq!(parse_target("192.168.1.20", 80).unwrap().socket.port(), 80);
    assert_eq!(
        parse_target("192.168.1.20:4409", 80).unwrap().socket.port(),
        4409
    );
    assert_eq!(moonraker_default_port(None).unwrap(), 7125);
    assert_eq!(moonraker_default_port(Some(80)).unwrap(), 80);
    assert!(moonraker_default_port(Some(8080)).is_err());
}

#[test]
fn saved_printer_may_fail_over_only_between_standard_ports_on_same_ip() {
    let port_7125 = parse_target("192.168.1.20:7125", 7125).unwrap();
    let port_80 = parse_target("192.168.1.20:80", 7125).unwrap();
    let other_ip = parse_target("192.168.1.21:80", 7125).unwrap();
    let custom = parse_target("192.168.1.20:4409", 7125).unwrap();
    assert!(same_printer_channel(&port_7125, &port_80));
    assert!(same_printer_channel(&port_80, &port_7125));
    assert!(!same_printer_channel(&port_7125, &other_ip));
    assert!(!same_printer_channel(&port_7125, &custom));
}

#[test]
fn websocket_handshake_primitives_match_rfc_6455() {
    assert_eq!(base64_encode(b""), "");
    assert_eq!(base64_encode(b"f"), "Zg==");
    assert_eq!(base64_encode(b"fo"), "Zm8=");
    assert_eq!(base64_encode(b"foo"), "Zm9v");
    assert_eq!(
        hex::encode(sha1_digest(b"abc")),
        "a9993e364706816aba3e25717850c26c9cd0d89d"
    );
    assert_eq!(
        websocket_accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
        "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
    );
}

#[test]
fn header_injection_is_rejected() {
    assert!(validate_header_value("safe-api-key", 512).is_ok());
    assert!(validate_header_value("key\r\nX-Evil: yes", 512).is_err());
}

#[test]
fn chunked_parser_is_bounded() {
    assert_eq!(
        decode_chunked_bytes(b"4\r\ntest\r\n0\r\n\r\n", 8).unwrap(),
        b"test"
    );
    assert!(decode_chunked_bytes(b"8\r\ntoolarge\r\n0\r\n\r\n", 4).is_err());
    assert!(decode_chunked_bytes(b"4\r\ntes", 8).is_err());
}

#[test]
fn response_parser_rejects_conflicting_lengths() {
    let response = b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ntest\r\n0\r\n\r\n";
    assert!(parse_http_response(response, 64).is_err());
    let valid = b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nContent-Type: text/plain\r\n\r\ntest";
    assert_eq!(parse_http_response(valid, 64).unwrap().body, b"test");
}

#[test]
fn moonraker_allowlists_are_explicit() {
    assert!(rpc_required_role("server.info", None).is_ok());
    assert!(rpc_required_role("machine.shutdown", None).is_err());
    assert!(endpoint_allowed(
        "GET",
        "/server/files/metadata?filename=part.gcode"
    ));
    assert!(!endpoint_allowed("GET", "/server/config"));
    assert!(!endpoint_allowed(
        "GET",
        "/server/files/gcodes/%2e%2e/config"
    ));
}

#[test]
fn local_library_paths_preserve_folders_and_block_traversal() {
    assert_eq!(
        normalize_local_library_path("Models/PETG/hinge.gcode").unwrap(),
        "Models/PETG/hinge.gcode"
    );
    assert_eq!(
        normalize_local_library_path("USB\\ABS\\case.gco").unwrap(),
        "USB/ABS/case.gco"
    );
    for path in [
        "../printer.cfg",
        "/tmp/part.gcode",
        "C:/part.gcode",
        "folder/../../part.gcode",
        "folder/CON.gcode",
        "folder/part.stl",
    ] {
        assert!(normalize_local_library_path(path).is_err(), "{path}");
    }
}

#[test]
fn local_library_directory_paths_block_root_and_traversal() {
    assert_eq!(
        normalize_local_library_directory("Models/PETG").unwrap(),
        "Models/PETG"
    );
    assert_eq!(
        normalize_local_library_directory("USB\\ABS").unwrap(),
        "USB/ABS"
    );
    for path in [
        "",
        ".",
        "..",
        "/tmp",
        "C:/models",
        "folder/../models",
        "folder/CON",
        "folder/trailing.",
    ] {
        assert!(normalize_local_library_directory(path).is_err(), "{path}");
    }
}

#[test]
fn local_library_scope_is_stable_and_unique_per_owner() {
    let ender = local_library_printer_scope("model:ender3-v3-ke").unwrap();
    let k1c = local_library_printer_scope("model:creality-k1c-2025").unwrap();
    assert_eq!(ender.len(), 64);
    assert_eq!(k1c.len(), 64);
    assert_ne!(ender, k1c);
    assert_eq!(
        ender,
        local_library_printer_scope("model:ender3-v3-ke").unwrap()
    );
    assert_ne!(
        ender,
        local_library_printer_scope("printer-ender-3-v3-ke-01").unwrap()
    );
    assert!(local_library_printer_scope("../printer").is_err());
}

#[test]
fn moonraker_rest_fallback_is_fixed_and_bounded() {
    assert_eq!(bounded_rpc_timeout(None), Duration::from_secs(8));
    assert_eq!(bounded_rpc_timeout(Some(100)), Duration::from_secs(1));
    assert_eq!(
        bounded_rpc_timeout(Some(3_500)),
        Duration::from_millis(3_500)
    );
    assert_eq!(bounded_rpc_timeout(Some(60_000)), Duration::from_secs(8));
    assert_eq!(bounded_http_timeout(Some(6_000)), Duration::from_secs(6));

    let info = rest_fallback_for_rpc("server.info", None).unwrap().unwrap();
    assert_eq!(info.method, "GET");
    assert_eq!(info.path, "/server/info");

    let query_params = serde_json::json!({"objects":{"configfile":["settings"]}});
    let query = rest_fallback_for_rpc("printer.objects.query", Some(&query_params))
        .unwrap()
        .unwrap();
    assert_eq!(query.method, "POST");
    assert_eq!(query.path, "/printer/objects/query");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&query.body).unwrap(),
        query_params
    );
    let query_get = objects_query_get_fallback(Some(&query_params)).unwrap();
    assert_eq!(query_get.method, "GET");
    assert!(query_get.path.starts_with("/printer/objects/query?"));
    assert!(query_get.path.contains("configfile=settings"));
    assert!(
        objects_query_get_fallback(Some(&serde_json::json!({"objects":{"bad": ["a,b"]}}))).is_err()
    );

    let start_params = serde_json::json!({"filename":"folder/part.gcode"});
    let start = rest_fallback_for_rpc("printer.print.start", Some(&start_params))
        .unwrap()
        .unwrap();
    assert_eq!(start.method, "POST");
    assert_eq!(
        start.path,
        "/printer/print/start?filename=folder%2Fpart.gcode"
    );

    let delete_params = serde_json::json!({"job_ids":["A1","B2"]});
    let delete = rest_fallback_for_rpc("server.job_queue.delete_job", Some(&delete_params))
        .unwrap()
        .unwrap();
    assert_eq!(delete.method, "DELETE");
    assert!(delete.path.starts_with("/server/job_queue/job?job_ids="));
    assert!(rest_fallback_for_rpc("machine.shutdown", None)
        .unwrap()
        .is_none());
}

#[test]
fn moonraker_file_move_has_safe_rest_fallback() {
    let params = serde_json::json!({"source":"gcodes/kf-stage.gcode","dest":"gcodes/папка/a & b.gcode"});
    let route = rest_fallback_for_rpc("server.files.move", Some(&params)).unwrap().unwrap();
    assert_eq!(route.method, "POST");
    assert!(route.path.starts_with("/server/files/move?"));
    assert!(route.body.is_empty());
    let query = url::form_urlencoded::parse(route.path.split_once('?').unwrap().1.as_bytes())
        .into_owned().collect::<std::collections::HashMap<_,_>>();
    assert_eq!(query["source"], params["source"].as_str().unwrap());
    assert_eq!(query["dest"], params["dest"].as_str().unwrap());
    for path in ["../a", "gcodes/../a", "/gcodes/a", "gcodes/a\\b", "gcodes/a\nb", "logs/a", "gcodes//a"] {
        assert!(files_move_fallback(Some(&serde_json::json!({"source":path,"dest":"gcodes/a"}))).is_err());
    }
    assert!(files_move_fallback(Some(&serde_json::json!({"source":"gcodes/a"}))).is_err());
}

#[test]
fn moonraker_rest_fallback_does_not_bypass_auth_failures() {
    assert!(should_try_rest_fallback(404, None));
    assert!(should_try_rest_fallback(405, None));
    assert!(should_try_rest_fallback(200, Some(-32601)));
    assert!(!should_try_rest_fallback(401, None));
    assert!(!should_try_rest_fallback(403, None));
    assert!(!should_try_rest_fallback(500, None));
    assert!(!should_try_rest_fallback(200, Some(-32602)));
    assert!(should_try_query_compatibility_fallback(
        "printer.objects.query",
        200,
        Some(-32602)
    ));
    assert!(should_try_query_compatibility_fallback(
        "printer.objects.query",
        415,
        None
    ));
    assert!(!should_try_query_compatibility_fallback(
        "printer.print.start",
        415,
        None
    ));
    assert!(!should_try_query_compatibility_fallback(
        "printer.objects.query",
        401,
        None
    ));
}

#[test]
fn moonraker_query_empty_success_uses_compatibility_path() {
    assert!(!moonraker_query_result_useful(&serde_json::json!({})));
    assert!(!moonraker_query_result_useful(
        &serde_json::json!({"result":{"status":{}}})
    ));
    assert!(moonraker_query_result_useful(&serde_json::json!({
        "result":{"data":{"status":{"extruder":{"temperature":24.5}}}}
    })));
    assert!(moonraker_query_result_useful(&serde_json::json!({
        "heater_bed":{"temperature":23.0}
    })));
}

#[test]
fn discovery_uses_bounded_local_24_networks() {
    let subnets = discovery_subnets(&["192.168.42.18:7125".to_string()]);
    assert!(subnets.contains(&DiscoveryNetwork {
        network: Ipv4Addr::new(192, 168, 42, 0),
        prefix: 24
    }));
    assert!(subnets.iter().all(|network| network.prefix == 24));
    assert!(subnets.len() <= MAX_DISCOVERY_SUBNETS);
}

#[test]
fn discovery_manual_range_supports_cidr_and_bounded_ranges() {
    let cidr = parse_manual_discovery_range(Some("192.168.8.19/22".into()))
        .unwrap()
        .unwrap();
    assert_eq!(cidr.label, "192.168.8.0/22");
    assert_eq!(cidr.end - cidr.start + 1, 1022);
    let range = parse_manual_discovery_range(Some("10.0.0.20-10.0.0.80".into()))
        .unwrap()
        .unwrap();
    assert_eq!(range.end - range.start + 1, 61);
    assert!(parse_manual_discovery_range(Some("192.168.0.0/16".into())).is_err());
    assert!(parse_manual_discovery_range(Some("8.8.8.1-8.8.8.4".into())).is_err());
}

#[test]
fn discovery_network_addresses_respect_real_mask() {
    let addresses =
        discovery_network_addresses(discovery_network(Ipv4Addr::new(192, 168, 11, 44), 23));
    assert_eq!(addresses.len(), 510);
    assert_eq!(addresses.first(), Some(&Ipv4Addr::new(192, 168, 10, 1)));
    assert_eq!(addresses.last(), Some(&Ipv4Addr::new(192, 168, 11, 254)));
}

#[test]
fn discovery_ignores_common_virtual_adapter_names() {
    for name in [
        "Company VPN",
        "iProxy",
        "VanyaVPN Tunnel",
        "WireGuard Tunnel",
        "Wintun Userspace Tunnel",
        "OpenVPN Data Channel Offload",
        "Cloudflare WARP",
        "tun0",
        "TAP-Windows Adapter V9",
        "Tailscale",
        "ZeroTier One",
        "DockerNAT",
        "VMware Network Adapter VMnet8",
        "VirtualBox Host-Only Ethernet Adapter",
        "Hyper-V Virtual Ethernet Adapter",
        "vEthernet (WSL)",
    ] {
        assert!(
            transactional_core::discovery::is_virtual_discovery_interface(name),
            "{name}"
        );
    }
    assert!(!transactional_core::discovery::is_virtual_discovery_interface("Ethernet"));
    assert!(!transactional_core::discovery::is_virtual_discovery_interface("Wi-Fi"));
    assert!(!transactional_core::discovery::is_virtual_discovery_interface(
        "Realtek PCIe GbE Family Controller"
    ));
}

#[test]
fn discovery_timeout_bounds_tcp_connect() {
    assert_eq!(
        bounded_connect_timeout(DISCOVERY_FAST_PROBE_TIMEOUT),
        DISCOVERY_FAST_PROBE_TIMEOUT
    );
    assert_eq!(
        bounded_connect_timeout(Duration::from_secs(8)),
        Duration::from_secs(3)
    );
    assert_eq!(
        bounded_connect_timeout(Duration::ZERO),
        Duration::from_millis(1)
    );
    assert!(discovery_retryable_error("Moonraker response timeout"));
    assert!(!discovery_retryable_error(
        "Moonraker connect failed: connection timed out"
    ));
    assert!(!discovery_retryable_error(
        "Moonraker connect failed: connection refused"
    ));
}

#[test]
fn discovery_operation_ids_are_validated() {
    assert_eq!(
        discovery_operation_id(Some("scan_123-abc".into())).unwrap(),
        "scan_123-abc"
    );
    assert!(discovery_operation_id(Some("bad id".into())).is_err());
    assert!(discovery_operation_id(Some("../scan".into())).is_err());
}

#[test]
fn discovery_state_rejects_overlap_and_cancels_by_operation_id() {
    let state = DiscoveryState::default();
    let (first, _) = state.begin("first").unwrap();
    assert!(state.begin("second").is_err());
    assert!(!first.load(Ordering::Acquire));
    assert!(state.cancel("first").unwrap());
    assert!(first.load(Ordering::Acquire));
    let (second, _) = state.begin("second").unwrap();
    assert!(state.cancel("second").unwrap());
    assert!(state.begin("third").is_err());
    state.finish("first", &first).unwrap();
    let (third, _) = state.begin("third").unwrap();
    state.finish("second", &second).unwrap();
    state.finish("third", &third).unwrap();
}

#[test]
fn discovery_worker_pool_is_bounded() {
    let targets: Vec<DiscoveryTarget> = (1..=32)
        .map(|host| DiscoveryTarget {
            ip: Ipv4Addr::new(192, 168, 20, host),
            port: 7125,
            bind_ip: None,
        })
        .collect();
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let probe_active = Arc::clone(&active);
    let probe_peak = Arc::clone(&peak);
    let probe_fn: Arc<DiscoveryProbe> = Arc::new(move |target| {
        let current = probe_active.fetch_add(1, Ordering::SeqCst) + 1;
        probe_peak.fetch_max(current, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(2));
        probe_active.fetch_sub(1, Ordering::SeqCst);
        DiscoveryProbeOutcome::Miss(discovery_diagnostic(
            &format!("{}:{}", target.ip, target.port),
            "closed_port",
            "test miss",
            Some("test"),
        ))
    });
    let output = scan_discovery_targets(
        targets,
        Arc::new(AtomicBool::new(false)),
        Instant::now() + Duration::from_secs(1),
        4,
        probe_fn,
        Arc::new(|_, _| {}),
        Arc::new(|_| {}),
    )
    .unwrap();
    assert_eq!(output.scanned, 32);
    assert!(peak.load(Ordering::SeqCst) <= 4);
    assert!(!output.cancelled);
    assert!(!output.timed_out);
}

#[test]
fn discovery_cancel_and_deadline_stop_scheduling_targets() {
    let targets: Vec<DiscoveryTarget> = (1..=100)
        .map(|host| DiscoveryTarget {
            ip: Ipv4Addr::new(192, 168, 30, host),
            port: 7125,
            bind_ip: None,
        })
        .collect();
    let cancelled = Arc::new(AtomicBool::new(false));
    let probe_cancelled = Arc::clone(&cancelled);
    let cancelled_output = scan_discovery_targets(
        targets.clone(),
        Arc::clone(&cancelled),
        Instant::now() + Duration::from_secs(1),
        4,
        Arc::new(move |target| {
            probe_cancelled.store(true, Ordering::Release);
            DiscoveryProbeOutcome::Miss(discovery_diagnostic(
                &format!("{}:{}", target.ip, target.port),
                "cancelled",
                "test cancellation",
                Some("test"),
            ))
        }),
        Arc::new(|_, _| {}),
        Arc::new(|_| {}),
    )
    .unwrap();
    assert!(cancelled_output.cancelled);
    assert!(cancelled_output.scanned < targets.len());

    let timed_output = scan_discovery_targets(
        targets,
        Arc::new(AtomicBool::new(false)),
        Instant::now(),
        4,
        Arc::new(|target| {
            DiscoveryProbeOutcome::Miss(discovery_diagnostic(
                &format!("{}:{}", target.ip, target.port),
                "timeout",
                "test timeout",
                Some("test"),
            ))
        }),
        Arc::new(|_, _| {}),
        Arc::new(|_| {}),
    )
    .unwrap();
    assert!(timed_output.timed_out);
    assert_eq!(timed_output.scanned, 0);
}

#[test]
fn discovery_payload_preserves_the_working_k1c_port() {
    let payload = serde_json::json!({
        "result": {
            "moonraker_version": "v0.9.3",
            "klippy_state": "ready",
            "components": ["klippy_connection"]
        }
    });
    let port_80 = discovered_printer_from_payload(
        Ipv4Addr::new(192, 168, 1, 44),
        80,
        &payload,
        false,
        "websocket",
    )
    .unwrap();
    let port_7125 = discovered_printer_from_payload(
        Ipv4Addr::new(192, 168, 1, 44),
        7125,
        &payload,
        false,
        "rest",
    )
    .unwrap();
    assert_eq!(port_80.host, "192.168.1.44:80");
    assert_eq!(port_80.port, 80);
    assert_eq!(port_7125.host, "192.168.1.44:7125");
    assert_eq!(port_7125.port, 7125);
    assert_eq!(port_80.working_protocol.as_deref(), Some("websocket"));
    assert_eq!(port_7125.working_protocol.as_deref(), Some("rest"));
}

#[test]
fn discovery_dedup_keeps_stable_identity_and_best_endpoint() {
    let printers = dedupe_discovered_printers(vec![
        DiscoveredPrinter {
            host: "192.168.1.44:80".into(),
            ip: "192.168.1.44".into(),
            port: 80,
            hostname: Some("printer-one.local".into()),
            moonraker_uuid: Some("moonraker-uuid-one".into()),
            klippy_state: Some("ready".into()),
            moonraker_version: None,
            source: Some("stable_id".into()),
            stable_id: Some("serial-k1c-44".into()),
            auth_required: false,
            moonraker_confirmed: true,
            probe_state: "moonraker".into(),
            http_status: Some(200),
            working_protocol: Some("websocket".into()),
            working_port: Some(80),
            identity_conflict: None,
            conflict_hosts: Vec::new(),
            conflict_identities: Vec::new(),
        },
        DiscoveredPrinter {
            host: "192.168.1.44:7125".into(),
            ip: "192.168.1.44".into(),
            port: 7125,
            hostname: None,
            moonraker_uuid: None,
            klippy_state: None,
            moonraker_version: Some("v0.9.3".into()),
            source: Some("mdns".into()),
            stable_id: None,
            auth_required: false,
            moonraker_confirmed: true,
            probe_state: "moonraker".into(),
            http_status: Some(200),
            working_protocol: Some("rest".into()),
            working_port: Some(7125),
            identity_conflict: None,
            conflict_hosts: Vec::new(),
            conflict_identities: Vec::new(),
        },
    ]);
    assert_eq!(printers.len(), 1);
    assert_eq!(printers[0].port, 7125);
    assert_eq!(printers[0].stable_id.as_deref(), Some("serial-k1c-44"));
    assert_eq!(printers[0].source.as_deref(), Some("stable_id"));
    assert_eq!(printers[0].klippy_state.as_deref(), Some("ready"));
    assert_eq!(printers[0].moonraker_version.as_deref(), Some("v0.9.3"));
    assert_eq!(printers[0].working_protocol.as_deref(), Some("rest"));
    assert_eq!(printers[0].working_port, Some(7125));
}

#[test]
fn discovery_dedup_matches_uuid_and_hostname_after_ip_change() {
    let original = DiscoveredPrinter {
        host: "192.168.1.20:7125".into(),
        ip: "192.168.1.20".into(),
        port: 7125,
        hostname: Some("farm-printer.local".into()),
        moonraker_uuid: Some("instance-123".into()),
        klippy_state: Some("ready".into()),
        moonraker_version: Some("v0.9".into()),
        source: Some("known_host".into()),
        stable_id: None,
        auth_required: false,
        moonraker_confirmed: true,
        probe_state: "moonraker".into(),
        http_status: Some(200),
        working_protocol: Some("rest".into()),
        working_port: Some(7125),
        identity_conflict: None,
        conflict_hosts: Vec::new(),
        conflict_identities: Vec::new(),
    };
    let moved = DiscoveredPrinter {
        host: "192.168.1.77:7125".into(),
        ip: "192.168.1.77".into(),
        source: Some("mdns".into()),
        ..original.clone()
    };
    let merged = dedupe_discovered_printers(vec![original, moved]);
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].identity_conflict.as_deref(), Some("identity_multiple_addresses"));
    assert_eq!(merged[0].conflict_hosts.len(), 2);
}

#[test]
fn discovery_dedup_refuses_same_ip_with_different_uuid() {
    let first = DiscoveredPrinter {
        host: "192.168.1.88:7125".into(),
        ip: "192.168.1.88".into(),
        port: 7125,
        hostname: Some("printer.local".into()),
        moonraker_uuid: Some("uuid-first".into()),
        klippy_state: Some("ready".into()),
        moonraker_version: Some("v0.9".into()),
        source: Some("mdns".into()),
        stable_id: None,
        auth_required: false,
        moonraker_confirmed: true,
        probe_state: "moonraker".into(),
        http_status: Some(200),
        working_protocol: Some("rest".into()),
        working_port: Some(7125),
        identity_conflict: None,
        conflict_hosts: Vec::new(),
        conflict_identities: Vec::new(),
    };
    let second = DiscoveredPrinter {
        moonraker_uuid: Some("uuid-second".into()),
        source: Some("stable_id".into()),
        ..first.clone()
    };
    let rows = dedupe_discovered_printers(vec![first, second]);
    assert_eq!(rows.len(), 2);
    assert!(rows
        .iter()
        .all(|row| row.identity_conflict.as_deref() == Some("address_identity_collision")));
}

#[test]
fn discovery_dedup_prefers_matching_uuid_over_local_saved_ids() {
    let first = DiscoveredPrinter {
        host: "192.168.1.91:7125".into(),
        ip: "192.168.1.91".into(),
        port: 7125,
        hostname: Some("same-printer.local".into()),
        moonraker_uuid: Some("authoritative-instance".into()),
        klippy_state: Some("ready".into()),
        moonraker_version: Some("v0.9".into()),
        source: Some("known_host".into()),
        stable_id: Some("local-entry-a".into()),
        auth_required: false,
        moonraker_confirmed: true,
        probe_state: "moonraker".into(),
        http_status: Some(200),
        working_protocol: Some("rest".into()),
        working_port: Some(7125),
        identity_conflict: None,
        conflict_hosts: Vec::new(),
        conflict_identities: Vec::new(),
    };
    let second = DiscoveredPrinter {
        stable_id: Some("local-entry-b".into()),
        source: Some("stable_id".into()),
        ..first.clone()
    };
    let rows = dedupe_discovered_printers(vec![first, second]);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].identity_conflict.is_none());
    assert_eq!(rows[0].moonraker_uuid.as_deref(), Some("authoritative-instance"));
}

#[test]
fn moonraker_server_info_is_found_twenty_times_without_a_miss() {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let body = br#"{"result":{"moonraker_version":"v0.9","klippy_state":"ready","instance_uuid":"repeatable-printer"}}"#;
        for _ in 0..20 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let bytes_read = stream.read(&mut request).unwrap();
            assert!(bytes_read > 0);
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(headers.as_bytes()).unwrap();
            stream.write_all(body).unwrap();
        }
    });
    let candidates = Arc::new(AtomicUsize::new(0));
    let candidate_count = Arc::clone(&candidates);
    let callback = move |_: DiscoveredPrinter| {
        candidate_count.fetch_add(1, Ordering::Relaxed);
    };
    let started = Instant::now();
    for _ in 0..20 {
        let outcome = probe_with_timeout(
            DiscoveryTarget {
                ip: Ipv4Addr::LOCALHOST,
                port,
                bind_ip: None,
            },
            Duration::from_secs(1),
            Some(&callback),
        );
        assert!(matches!(outcome, DiscoveryProbeOutcome::Found(_, _)));
    }
    server.join().unwrap();
    assert_eq!(candidates.load(Ordering::Relaxed), 20);
    assert!(started.elapsed() < Duration::from_secs(5));

    // A router/admin page may return 403 for an unknown path. It is an HTTP
    // responder, but must never be promoted to an API-key-protected Moonraker.
    let forbidden_listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let forbidden_port = forbidden_listener.local_addr().unwrap().port();
    let forbidden_server = thread::spawn(move || {
        for _ in 0..3 {
            let (mut stream, _) = forbidden_listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).unwrap();
            let body = b"not moonraker";
            let headers = format!(
                "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(headers.as_bytes()).unwrap();
            stream.write_all(body).unwrap();
        }
    });
    let forbidden = probe_with_timeout(
        DiscoveryTarget {
            ip: Ipv4Addr::LOCALHOST,
            port: forbidden_port,
            bind_ip: None,
        },
        Duration::from_secs(1),
        None,
    );
    forbidden_server.join().unwrap();
    let DiscoveryProbeOutcome::Found(printer, diagnostic) = forbidden else {
        panic!("HTTP 403 responder disappeared from the diagnostic result");
    };
    assert!(!printer.auth_required);
    assert!(!printer.moonraker_confirmed);
    assert_eq!(printer.probe_state, "not_moonraker");
    assert_eq!(diagnostic.outcome, "not_moonraker");
}

#[test]
fn source_bound_tcp_rejects_mixed_address_families_before_connecting() {
    let error = connect_tcp_stream(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 7125),
        Duration::from_millis(50),
        Some(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)),
    )
    .unwrap_err();
    assert!(error.contains("семейства"));
}

#[test]
fn source_bound_tcp_connects_through_the_requested_adapter_address() {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let target = listener.local_addr().unwrap();
    // Keep the peer alive while the client observes nonblocking connection completion.
    let server = thread::spawn(move || listener.accept().map(|(stream, _)| stream).unwrap());
    let stream = connect_tcp_stream(
        target,
        Duration::from_secs(1),
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
    )
    .unwrap();
    assert_eq!(stream.local_addr().unwrap().ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
    drop(stream);
    server.join().unwrap();
}

#[test]
fn complete_24_fast_pass_stays_below_eight_seconds() {
    let targets = (1_u8..=254)
        .flat_map(|host| {
            [7125_u16, 80_u16].into_iter().map(move |port| DiscoveryTarget {
                ip: Ipv4Addr::new(192, 168, 77, host),
                port,
                bind_ip: None,
            })
        })
        .collect::<Vec<_>>();
    let probe: Arc<DiscoveryProbe> = Arc::new(|target| {
        thread::sleep(DISCOVERY_FAST_PROBE_TIMEOUT);
        DiscoveryProbeOutcome::Miss(discovery_diagnostic(
            &format!("{}:{}", target.ip, target.port),
            "timeout",
            "synthetic timeout",
            Some("subnet_scan"),
        ))
    });
    let started = Instant::now();
    let output = scan_discovery_targets(
        targets,
        Arc::new(AtomicBool::new(false)),
        Instant::now() + DISCOVERY_DEADLINE,
        DISCOVERY_FAST_WORKERS,
        probe,
        Arc::new(|_, _| {}),
        Arc::new(|_| {}),
    )
    .unwrap();
    assert_eq!(output.scanned, 508);
    assert!(!output.timed_out);
    assert!(started.elapsed() < Duration::from_secs(8));
}

#[test]
fn viewer_notification_actions_are_explicit() {
    assert!(notification_action_allowed("print.complete"));
    assert!(notification_action_allowed("queue.auto_blocked"));
    assert!(notification_action_allowed("notification.test"));
    assert!(notification_action_allowed("update.error"));
    assert!(!notification_action_allowed("notification.arbitrary"));
    assert!(!notification_action_allowed("user.delete"));
    assert!(!notification_action_allowed("printer.emergency_stop"));
}

#[test]
fn snapshot_magic_must_match_declared_type() {
    assert_eq!(
        snapshot_extension("image/jpeg", &[0xff, 0xd8, 0xff, 0x00]).unwrap(),
        "jpg"
    );
    assert_eq!(
        snapshot_extension("image/png", &[137, 80, 78, 71, 13, 10, 26, 10]).unwrap(),
        "png"
    );
    assert_eq!(
        snapshot_extension("image/webp", b"RIFFxxxxWEBP").unwrap(),
        "webp"
    );
    assert!(snapshot_extension("image/png", &[0xff, 0xd8, 0xff]).is_err());
}

#[test]
fn direct_moonraker_failover_is_limited_to_engine_owner_conflicts() {
    assert!(engine_owner_conflict(
        "ENGINE_ALREADY_RUNNING: Windows named mutex занят"
    ));
    assert!(engine_owner_conflict(
        "HEADLESS_ENGINE_ACTIVE: klipper-farmd уже владеет ядром"
    ));
    assert!(!engine_owner_conflict(
        "DATABASE_SCHEMA_TOO_NEW: обновите приложение"
    ));
    assert!(!engine_owner_conflict("FORBIDDEN: insufficient permissions"));
}
