//! Слияние и ранжирование результатов обнаружения.
//!
//! Чистые функции: на вход список найденных принтеров, на выход упорядоченный
//! и очищенный список. Ни Tauri, ни сети, ни базы — поэтому проверяются
//! отдельно от приложения.

use crate::DiscoveredPrinter;

pub(crate) fn discovery_source_rank(source: Option<&str>) -> u8 {
    match source {
        Some("stable_id") => 0,
        Some("mdns") => 1,
        Some("ssdp") => 2,
        Some("known_host") => 3,
        Some("arp") => 4,
        Some("manual") => 5,
        Some("subnet_scan") => 6,
        _ => 7,
    }
}

pub(crate) fn discovery_identity(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_end_matches('.').to_ascii_lowercase())
}

pub(crate) fn discovery_identity_match(left: &DiscoveredPrinter, right: &DiscoveredPrinter) -> bool {
    discovery_identity(left.stable_id.as_deref())
        .zip(discovery_identity(right.stable_id.as_deref()))
        .is_some_and(|(left, right)| left == right)
        || discovery_identity(left.moonraker_uuid.as_deref())
            .zip(discovery_identity(right.moonraker_uuid.as_deref()))
            .is_some_and(|(left, right)| left == right)
}

pub(crate) fn discovery_identity_conflicts(left: &DiscoveredPrinter, right: &DiscoveredPrinter) -> bool {
    let left_uuid = discovery_identity(left.moonraker_uuid.as_deref());
    let right_uuid = discovery_identity(right.moonraker_uuid.as_deref());
    if let (Some(left), Some(right)) = (left_uuid, right_uuid) {
        return left != right;
    }
    discovery_identity(left.stable_id.as_deref())
        .zip(discovery_identity(right.stable_id.as_deref()))
        .is_some_and(|(left, right)| left != right)
}

pub(crate) fn discovery_identity_labels(printer: &DiscoveredPrinter) -> Vec<String> {
    let mut values = Vec::new();
    if let Some(value) = discovery_identity(printer.stable_id.as_deref()) {
        values.push(format!("stable:{value}"));
    }
    if let Some(value) = discovery_identity(printer.moonraker_uuid.as_deref()) {
        values.push(format!("uuid:{value}"));
    }
    values
}

pub(crate) fn discovery_result_rank(printer: &DiscoveredPrinter) -> (u8, u8, u8) {
    let state = if printer.moonraker_confirmed && !printer.auth_required {
        0
    } else if printer.auth_required {
        1
    } else if printer.probe_state == "http_response" {
        2
    } else {
        3
    };
    (
        state,
        if printer.port == 7125 { 0 } else { 1 },
        discovery_source_rank(printer.source.as_deref()),
    )
}

pub(crate) fn dedupe_discovered_printers(mut printers: Vec<DiscoveredPrinter>) -> Vec<DiscoveredPrinter> {
    printers.sort_by_key(discovery_result_rank);
    let mut merged: Vec<DiscoveredPrinter> = Vec::with_capacity(printers.len());
    for mut printer in printers {
        for current in &mut merged {
            if !discovery_identity_conflicts(current, &printer) {
                continue;
            }
            let same_ip = current.ip == printer.ip;
            let same_hostname = discovery_identity(current.hostname.as_deref())
                .zip(discovery_identity(printer.hostname.as_deref()))
                .is_some_and(|(left, right)| left == right);
            if !same_ip && !same_hostname {
                continue;
            }
            let code = if same_ip {
                "address_identity_collision"
            } else {
                "hostname_identity_collision"
            };
            let hosts = [current.host.clone(), printer.host.clone()];
            let identities = discovery_identity_labels(current)
                .into_iter()
                .chain(discovery_identity_labels(&printer))
                .collect::<Vec<_>>();
            mark_discovery_conflict(current, code, hosts.clone(), identities.clone());
            mark_discovery_conflict(&mut printer, code, hosts, identities);
        }
        let Some(current) = merged
            .iter_mut()
            .find(|current| same_discovered_printer(current, &printer))
        else {
            merged.push(printer);
            continue;
        };
        if discovery_identity_match(current, &printer) && current.ip != printer.ip {
            let hosts = [current.host.clone(), printer.host.clone()];
            let identities = discovery_identity_labels(current)
                .into_iter()
                .chain(discovery_identity_labels(&printer))
                .collect::<Vec<_>>();
            mark_discovery_conflict(
                current,
                "identity_multiple_addresses",
                hosts,
                identities,
            );
        }
        if current.stable_id.is_none() {
            current.stable_id = printer.stable_id.clone();
        }
        if current.klippy_state.is_none() {
            current.klippy_state = printer.klippy_state.clone();
        }
        if current.moonraker_version.is_none() {
            current.moonraker_version = printer.moonraker_version.clone();
        }
        if current.hostname.is_none() {
            current.hostname = printer.hostname.clone();
        }
        if current.moonraker_uuid.is_none() {
            current.moonraker_uuid = printer.moonraker_uuid.clone();
        }
        if current.http_status.is_none() {
            current.http_status = printer.http_status;
        }
        if current.working_protocol.is_none() {
            current.working_protocol = printer.working_protocol.clone();
            current.working_port = printer.working_port;
        }
        current.moonraker_confirmed |= printer.moonraker_confirmed;
        if current.identity_conflict.is_none() {
            current.identity_conflict = printer.identity_conflict;
        }
        current.conflict_hosts.extend(printer.conflict_hosts);
        current.conflict_hosts.sort();
        current.conflict_hosts.dedup();
        current.conflict_identities.extend(printer.conflict_identities);
        current.conflict_identities.sort();
        current.conflict_identities.dedup();
        if discovery_source_rank(printer.source.as_deref())
            < discovery_source_rank(current.source.as_deref())
        {
            current.source = printer.source;
        }
    }
    merged.truncate(MAX_DISCOVERY_RESULTS);
    merged
}

pub(crate) const MAX_DISCOVERY_RESULTS: usize = 64;

pub(crate) fn same_discovered_printer(left: &DiscoveredPrinter, right: &DiscoveredPrinter) -> bool {
    if discovery_identity_conflicts(left, right) {
        return false;
    }
    if discovery_identity_match(left, right) {
        return true;
    }
    left.ip == right.ip
        || discovery_identity(left.hostname.as_deref())
            .zip(discovery_identity(right.hostname.as_deref()))
            .is_some_and(|(left, right)| left == right)
}

pub(crate) fn mark_discovery_conflict(
    printer: &mut DiscoveredPrinter,
    code: &str,
    hosts: impl IntoIterator<Item = String>,
    identities: impl IntoIterator<Item = String>,
) {
    if printer.identity_conflict.is_none() {
        printer.identity_conflict = Some(code.to_string());
    }
    printer.conflict_hosts.extend(hosts);
    printer.conflict_hosts.sort();
    printer.conflict_hosts.dedup();
    printer.conflict_identities.extend(identities);
    printer.conflict_identities.sort();
    printer.conflict_identities.dedup();
}
