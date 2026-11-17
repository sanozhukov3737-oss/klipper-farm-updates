import type { KnownPrinterPreset, PrinterConfig, PrinterConfigurationSnapshot, PrinterDetectionFacts, PrinterDetectionResult, PrinterDeviceIdentity } from '../types';
import { iconForPreset, profileForPreset } from './printerProfile';
import { printerDetectionFirmwareSignature } from './printerDetection';
import { refreshDeviceIdentityEvidence } from './deviceIdentity';

export type CompleteDetection=PrinterDetectionResult&{
  facts:PrinterDetectionFacts;
  deviceIdentity?:PrinterDeviceIdentity;
  probeCoverage?:{successful:number;total:number;available:string[];missing:string[]};
};

export const copyDetection=({engineVersion,status,decision,model,confidence,score,margin,candidates,evidence,conflicts,fingerprint}:PrinterDetectionResult):PrinterDetectionResult=>({engineVersion,status,decision,model,confidence,score,margin,candidates,evidence,conflicts,fingerprint});

export function detectionSnapshot(detection:CompleteDetection):PrinterConfigurationSnapshot{
  return{
    version:2,
    capturedAt:Date.now(),
    fingerprint:detection.fingerprint,
    facts:detection.facts,
    firmwareSignature:printerDetectionFirmwareSignature(detection.facts),
    probeCoverage:detection.probeCoverage,
    deviceIdentity:detection.deviceIdentity,
  };
}

export function applyModelDetection(config:PrinterConfig,detection:CompleteDetection,confirmProbable=false):PrinterConfig{
  const report=copyDetection(detection);
  const probable=detection.decision==='probable'&&detection.model!=='custom';
  const apply=detection.decision==='confirmed'||(probable&&confirmProbable);
  const conflict=detection.decision==='conflict';
  const unknown=detection.decision==='unknown';
  const appliedPreset=apply?detection.model as KnownPrinterPreset:undefined;
  const currentPreset=config.modelSelection?.selectedPreset??config.profile?.preset??'custom';
  const selectedPreset=appliedPreset??(unknown?'custom':currentPreset);
  const priority=config.profile?.priority??0;
  const nextProfile=appliedPreset
    ?{...profileForPreset(appliedPreset),priority}
    :unknown
      ?{...profileForPreset('custom'),priority}
      :config.profile??profileForPreset('custom');
  return{
    ...config,
    icon:appliedPreset||unknown?iconForPreset(selectedPreset):config.icon,
    profile:nextProfile,
    // Automatic model refresh may collect more optional hardware fields than
    // the original scan. Enrich evidence, but never replace an established
    // stable ID behind the operator's back.
    deviceIdentity:refreshDeviceIdentityEvidence(config.deviceIdentity,detection.deviceIdentity),
    modelSelection:{
      mode:'automatic',
      selectedPreset,
      source:apply?(confirmProbable?'confirmed':'automatic'):'automatic',
      updatedAt:Date.now(),
      appliedFingerprint:apply?detection.fingerprint:unknown||conflict?undefined:config.modelSelection?.appliedFingerprint,
      appliedEngineVersion:apply?detection.engineVersion:unknown||conflict?undefined:config.modelSelection?.appliedEngineVersion,
      pendingPreset:probable&&!confirmProbable?detection.model as KnownPrinterPreset:undefined,
      confirmationRequired:probable&&!confirmProbable,
      lastDetection:report,
    },
    configSnapshot:detectionSnapshot(detection),
  };
}
