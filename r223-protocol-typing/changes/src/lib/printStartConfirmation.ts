import type { JsonRecord } from './moonrakerPayload';
export const PRINT_START_CONFIRMATION_MS = 30_000;

/** Evidence from the local start wrapper: this invocation never reached the
 * print-start RPC call. Text received from a transport is not this evidence. */
export class PrintStartNotSentError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'PrintStartNotSentError';
    this.cause = cause;
  }
}

export function printStartDefinitelyNotSent(error: unknown): error is PrintStartNotSentError {
  return error instanceof PrintStartNotSentError;
}

export function uncertainPrintStart(error: unknown) {
  if (printStartDefinitelyNotSent(error)) return false;
  if (error instanceof Error && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /PRINT_START_UNCONFIRMED|RESULT_UNKNOWN|OPERATION_PENDING|OPERATION_DEADLINE_EXCEEDED|(?:^|[_\W])TIMEOUT(?:$|[_\W])|\btimed out\b|тайм.?аут/i.test(message);
}

/** Resolve absolute printer paths only against its freshly queried SD root. */
export function matchingPrintFilename(actual: unknown, expected: string, gcodeRoot?: string) {
  if(typeof actual!=='string'||!actual)return false;
  const clean=(value:string)=>value.replace(/\\/g,'/').replace(/^\.\//,'').normalize('NFC');
  let path=clean(actual);
  if(/^(?:\/|[a-z]:\/)/i.test(path)){
    const root=gcodeRoot?clean(gcodeRoot).replace(/\/+$/,''):'';
    if(!/^(?:\/|[a-z]:\/)/i.test(root)||!path.startsWith(root+'/'))return false;
    path=path.slice(root.length+1);
  }
  if(path.split('/').some(part=>!part||part==='.'||part==='..'))return false;
  return path===clean(expected);
}

export function printStartObservation(status: JsonRecord, filename: string, gcodeRoot?: string) {
  const stats = status?.print_stats;
  const sd=status?.virtual_sdcard;
  const state = String(stats?.state ?? 'unknown').trim().toLowerCase()||'unknown';
  const statsFilename=typeof stats?.filename==='string'?stats.filename:'';
  const sdFilename=typeof sd?.file_path==='string'?sd.file_path:'';
  const statsMatches=matchingPrintFilename(statsFilename,filename,gcodeRoot);
  const sdMatches=matchingPrintFilename(sdFilename,filename,gcodeRoot);
  const explicitActive=state==='printing'||state==='paused';
  // A loaded file, old progress or an idle/complete/error state is not a start.
  // Both objects come from one fresh query; never merge a cached filename here.
  const activeSd=sd?.is_active===true;
  const confirmed=statsFilename
    ?statsMatches&&(explicitActive||(state==='unknown'&&activeSd&&(!sdFilename||sdMatches)))
    :sdMatches&&(state==='paused'||(activeSd&&(state==='printing'||state==='unknown')));
  return { confirmed, state:confirmed?(state==='paused'?'paused':'printing'):state,
    filename: statsFilename||sdFilename, message: String(stats?.message ?? '') };
}
