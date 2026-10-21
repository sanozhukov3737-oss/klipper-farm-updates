export type PrinterState = 'ready'|'printing'|'paused'|'error'|'offline';
export type PrinterConnectionState = 'connecting'|'online'|'degraded'|'offline';
export type PrinterKlippyState = 'ready'|'startup'|'shutdown'|'error'|'disconnected'|'unknown';
export type PrinterConnectionProtocol = 'websocket'|'rest'|'jsonrpc';
export type PrinterConnectionReason = 'websocket'|'rest_jsonrpc'|'klipper_startup'|'authorization'|'klipper_shutdown'|'klipper_error'|'daemon_recovering'|'network'|'quarantine'|'connecting'|'unknown';
export type PrinterIcon = 'k1'|'k1max'|'ender'|'corexy'|'bedslinger'|'custom';
export type KnownPrinterPreset = 'ender3-v3-ke'|'ender3-v3-se'|'creality-k1c-2025'|'creality-k1-max'|'flashforge-ad5m';
export type PrinterPreset = KnownPrinterPreset|'custom';
export type PrinterDetectionConfidence = 'high'|'medium'|'low'|'unknown';
export type PrinterDetectionStatus = 'matched'|'ambiguous'|'unknown';
export type PrinterDetectionDecision = 'confirmed'|'probable'|'conflict'|'unknown';
export type PrinterDetectionEvidenceSource = 'machine'|'firmware'|'config'|'objects'|'geometry'|'kinematics';
export type PrinterDetectionEvidenceGroup = 'identity'|'platform'|'mechanics'|'geometry'|'levelling'|'board'|'macros';
export interface PrinterDetectionFacts {
  identity?:{manufacturer?:string;model?:string;product?:string;board?:string;hostname?:string;machineId?:string;uuid?:string;serial?:string;mcuSerial?:string;macAddress?:string};
  firmware?:{distribution?:string;family?:string;version?:string};
  kinematics?:'cartesian'|'corexy'|'delta'|'unknown';
  configSections?:string[];
  objectNames?:string[];
  macroNames?:string[];
  geometry?:{xMin?:number;xMax?:number;yMin?:number;yMax?:number;zMax?:number;bedX?:number;bedY?:number;enclosed?:boolean};
}
export interface PrinterDetectionEvidence {
  id:string;
  model:KnownPrinterPreset;
  source:PrinterDetectionEvidenceSource;
  group:PrinterDetectionEvidenceGroup;
  weight:number;
  strength:'strong'|'medium'|'weak';
}
export interface PrinterDetectionCandidate { model:KnownPrinterPreset;score:number;groups:PrinterDetectionEvidenceGroup[];evidenceIds:string[]; }
export interface PrinterDetectionConflict { id:'multiple-explicit-identities'|'unsupported-variant'|'insufficient-margin'|'kinematics-mismatch'|'geometry-mismatch';models:KnownPrinterPreset[]; }
export interface PrinterDetectionResult {
  engineVersion:number;
  status:PrinterDetectionStatus;
  decision:PrinterDetectionDecision;
  model:PrinterPreset;
  confidence:PrinterDetectionConfidence;
  score:number;
  margin:number;
  candidates:PrinterDetectionCandidate[];
  evidence:PrinterDetectionEvidence[];
  conflicts:PrinterDetectionConflict[];
  fingerprint:string;
}
export interface PrinterDeviceIdentity {
  version:1;
  stableId:string;
  strength:'hardware'|'network'|'hostname'|'composite';
  dedupeSafe:boolean;
  observedAt:number;
  signals:Partial<Record<'machineId'|'uuid'|'serial'|'mcuSerial'|'macAddress'|'hostname'|'board'|'manufacturer'|'product',string>>;
}
export interface PrinterConfigurationSnapshot { version:1|2;capturedAt:number;fingerprint:string;facts:PrinterDetectionFacts;firmwareSignature?:string;probeCoverage?:{successful:number;total:number;available:string[];missing:string[]};deviceIdentity?:PrinterDeviceIdentity; }
export interface PrinterModelSelection {
  mode:'automatic'|'manual';
  selectedPreset:PrinterPreset;
  source?:'automatic'|'confirmed'|'manual'|'legacy';
  updatedAt?:number;
  appliedFingerprint?:string;
  appliedEngineVersion?:number;
  pendingPreset?:KnownPrinterPreset;
  confirmationRequired?:boolean;
  lastDetection?:PrinterDetectionResult;
}
export interface Webcam { name:string; enabled:boolean; stream_url:string; snapshot_url:string; flip_horizontal?:boolean; flip_vertical?:boolean; rotation?:number; target_fps?:number; }
export interface PrinterProfile { preset?:PrinterPreset; bedX:number; bedY:number; xMin?:number; xMax?:number; yMin?:number; yMax?:number; maxZ:number; nozzle:number; materials:string[]; enclosed?:boolean; priority?:number; maxNozzleTemp?:number; maxBedTemp?:number; firmwareFamily?:'klipper'|'creality-klipper'|'flashforge-klipper'; }
export interface PrinterCapabilities { version:number;attestedAt:number;firmwareSignature?:string;geometry:{xMin?:number;xMax?:number;yMin?:number;yMax?:number;zMax?:number;coordinateSystem?:string;kinematics?:string};maxNozzleTemp?:number;maxBedTemp?:number;camera:boolean;bedSensor:boolean;macros:string[];queueApi:boolean;rest:boolean;websocket:boolean;canCancel:boolean;canPause:boolean;canResume:boolean;firmwareFeatures:string[];evidence:string[];compatible:boolean;quarantineReason?:string; }
export interface PrinterConfig { id:string; name:string; nameSource?:'automatic'|'custom'; host:string; catalogModelId?:string; apiKey?:string; apiKeyStored?:boolean; icon?:PrinterIcon; imageData?:string; accent?:string; tags?:string[]; profile?:PrinterProfile; modelSelection?:PrinterModelSelection; configSnapshot?:PrinterConfigurationSnapshot; deviceIdentity?:PrinterDeviceIdentity; capabilities?:PrinterCapabilities; }
export interface PrinterStatus { state:PrinterState; connectionState?:PrinterConnectionState; klippyState?:PrinterKlippyState; connectionMessage?:string; connectionReason?:PrinterConnectionReason; connectionProtocol?:PrinterConnectionProtocol; connectionPort?:number; remoteControlSuspended?:boolean; filename?:string; progress:number; printDuration:number; totalDuration?:number; currentLayer?:number; totalLayers?:number; nozzle:number; nozzleTarget:number; bed:number; bedTarget:number; telemetryUpdatedAt?:number; jobUpdatedAt?:number; message?:string; position?:number[]; speedFactor?:number; fanSpeed?:number; filamentDetected?:boolean; filamentUsedMm?:number; printStatsState?:string; lastSeen?:number; lastAttempt?:number; lastFailure?:number; latency?:number; reconnectAttempt?:number; consecutiveFailures?:number; }
export interface PrinterModel extends PrinterConfig { status:PrinterStatus; webcams:Webcam[]; }
export interface DiscoveredPrinter { host:string;ip:string;port:number;hostname?:string;moonraker_uuid?:string;klippy_state?:string;moonraker_version?:string;source?:'stable_id'|'mdns'|'ssdp'|'known_host'|'arp'|'manual'|'subnet_scan';stable_id?:string;auth_required?:boolean;moonraker_confirmed?:boolean;probe_state?:'moonraker'|'auth_required'|'http_response'|'not_moonraker'|string;http_status?:number;working_protocol?:PrinterConnectionProtocol;working_port?:number;identity_conflict?:'address_identity_collision'|'hostname_identity_collision'|'identity_multiple_addresses'|string;conflict_hosts?:string[];conflict_identities?:string[];model?:PrinterPreset;detectedName?:string;confidence?:PrinterDetectionConfidence;evidence?:string[];detection?:PrinterDetectionResult;detecting?:boolean;reachable?:boolean;probeWarnings?:string[];probeCoverage?:{successful:number;total:number;available:string[];missing:string[]};deviceIdentity?:PrinterDeviceIdentity;probePass?:'fast'|'slow';}
export interface DiscoveryDiagnosticEntry {host:string;outcome:'moonraker'|'authorization_required'|'http_404'|'closed_port'|'timeout'|'not_moonraker'|'network_error'|'cancelled'|string;detail:string;source?:string;adapter?:string;durationMs?:number;duration_ms?:number;}
export interface DiscoveryAdapter {name:string;address:string;network:string;scan_network?:string;scanNetwork?:string;eligible?:boolean;reason?:string;ipv6Addresses?:string[];ipv6_addresses?:string[];}
export interface DiscoveryDiagnostics {counts:Record<string,number>;entries:DiscoveryDiagnosticEntry[];adapters:DiscoveryAdapter[];}
export interface DiscoveryResult { operation_id?:string;printers:DiscoveredPrinter[];scanned_subnets:string[];scanned?:number;total?:number;cancelled?:boolean;timed_out?:boolean;duration_ms?:number;retried?:number;manual_range?:string;diagnostics?:DiscoveryDiagnostics;fast_recovery?:boolean;fastRecovery?:boolean; }
export interface NetworkEnvironmentSnapshot {fingerprint:string;observedAt:number;adapters:DiscoveryAdapter[];}
export interface DiscoveryProgress { operation_id:string;phase:'started'|'hybrid'|'scanning'|'retrying'|'complete'|'cancelled'|'timed_out';scanned:number;total:number;found:number; }
export interface DiscoveryFound {operation_id:string;printer:DiscoveredPrinter;}
export interface HistoryJob { job_id?:string; filename:string; status?:string; start_time?:number; end_time?:number; print_duration?:number; total_duration?:number; filament_used?:number; metadata?:Record<string,unknown>; }
export interface QueueJob { filename:string; job_id:string; time_added?:number; time_in_queue?:number; }
export interface QueueStatus { queued_jobs:QueueJob[]; queue_state:string; }
export interface GCodeThumbnail { width?:number; height?:number; size?:number; thumbnail_path?:string; relative_path?:string; data?:string; }
export interface GCodeMetadata { filename:string; estimated_time?:number; filament_total?:number; filament_weight_total?:number; filament_type?:string; filament_name?:string; layer_height?:number; object_height?:number; nozzle_diameter?:number; first_layer_extr_temp?:number; first_layer_bed_temp?:number; printer_vendor?:string; printer_model?:string; slicer?:string; thumbnails?:GCodeThumbnail[]; }
export interface GCodeFileEntry { path:string;size?:number;modified?:number; }
export interface TemperatureStore { [sensor:string]: { temperatures?:Array<number|null>; targets?:number[]; speeds?:number[] }; }
export type SmartJobState='waiting'|'dispatching'|'running'|'blocked'|'done'|'error';
export interface SmartJobRequirements { material?:string; nozzle?:number; maxZ?:number; bedX?:number; bedY?:number; enclosed?:boolean; preferredPrinterId?:string; }
export interface SmartJob { id:string; name:string; fileName:string; addedAt:number; priority:number; state:SmartJobState; requirements:SmartJobRequirements; assignedPrinterId?:string; backupPrinterId?:string; failedPrinterIds?:string[]; retryCount?:number; maxRetries?:number; scheduledAt?:number; message?:string; sourcePrinterId?:string; sourcePath?:string; startedAt?:number; printingObserved?:boolean; }
export type FilamentFinish = 'normal' | 'silk' | 'matte';
export interface Spool { id:string; name:string; material:string; color?:string; finish?:FilamentFinish; serial?:string; lot?:string; barcode?:string; ordinal?:number; initialWeight:number; remainingWeight:number; price:number; currency:string; printerId?:string; createdAt:number; }
export interface ScheduledJob { id:string; filename:string; printerId?:string; scheduledAt:number; repeat:'once'|'daily'|'weekly'; enabled:boolean; note?:string; }
export interface LibraryFile { printerId:string; printerName:string; path:string; metadata?:GCodeMetadata; }
export interface CostSettings { electricityPerKwh:number; printerWatts:number; laborPerHour:number; currency:string; }
export interface JobCost { material:number; electricity:number; labor:number; total:number; currency:string; }

export type FileCompatibilityLevel='compatible'|'warning'|'blocked'|'unknown';
export interface FileCompatibility { level:FileCompatibilityLevel; reasons:string[]; }
export interface PrintRecord { id:string;ts:number;printerId:string;printerName:string;filename:string;status:'completed'|'error'|'cancelled';duration:number;filamentUsed?:number;material?:string;nozzle?:number;objectHeight?:number;slicer?:string;snapshotId?:string;message?:string; }

export interface SpoolmanStatus { spoolman_connected:boolean; spool_id:number|null; pending_reports?:Array<{spool_id:number;filament_used:number}>; }
export interface SpoolmanSpool { id:number; remaining_weight?:number; used_weight?:number; archived?:boolean; filament?:{name?:string;material?:string;color_hex?:string;weight?:number;vendor?:{name?:string}}; }
