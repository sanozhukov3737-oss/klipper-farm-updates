const fallbackEndpointKey=(value:string)=>{
  const normalized=value.trim().toLowerCase().replace(/^http:\/\//,'').replace(/\/+$/,'');
  if(!normalized)return '';
  // IPv6 and malformed values are deliberately left stable instead of guessed.
  if(normalized.startsWith('[')||normalized.split(':').length>2)return normalized;
  return normalized.includes(':')?normalized:`${normalized}:7125`;
};

const explicitPort=(value:string)=>{
  const authority=value.trim().replace(/^https?:\/\//i,'').replace(/\/+$/,'');
  const match=authority.startsWith('[')?authority.match(/^\[[^\]]+\]:(\d+)$/):authority.match(/^[^:]+:(\d+)$/);
  const port=Number(match?.[1]);
  return Number.isInteger(port)&&port>0&&port<=65535?port:undefined;
};

/** Canonical Moonraker endpoint identity. Port 7125 is implicit in the UI. */
export function printerEndpointKey(value:string){
  const trimmed=value.trim();
  if(!trimmed)return '';
  try{
    const url=new URL(/^https?:\/\//i.test(trimmed)?trimmed:`http://${trimmed}`);
    if(url.protocol!=='http:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return `invalid:${trimmed.toLowerCase()}`;
    return `${url.hostname.toLowerCase()}:${explicitPort(trimmed)??(Number(url.port)||7125)}`;
  }catch{return fallbackEndpointKey(trimmed)}
}

export const samePrinterEndpoint=(left:string,right:string)=>printerEndpointKey(left)===printerEndpointKey(right);

/** One physical network address, regardless of the vendor's HTTP/WS port.
 * A K1 reachable on ports 80 and 7125 is still one printer. IPv6 interface
 * scopes remain part of the address so two link-local interfaces are distinct.
 */
export function printerAddressKey(value:string){
  const trimmed=value.trim();
  if(!trimmed)return '';
  const canonicalHost=(hostname:string)=>{
    const host=hostname.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
    const mapped=host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if(mapped){const high=parseInt(mapped[1],16),low=parseInt(mapped[2],16);return `${high>>8}.${high&255}.${low>>8}.${low&255}`}
    return host;
  };
  try{
    const url=new URL(/^https?:\/\//i.test(trimmed)?trimmed:`http://${trimmed}`);
    if(url.protocol!=='http:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return `invalid:${trimmed.toLowerCase()}`;
    return canonicalHost(url.hostname);
  }catch{
    const scoped=trimmed.match(/^\[([^\]]+)%([0-9]+)\](?::[0-9]+)?\/?$/);
    if(scoped)try{return `${canonicalHost(new URL(`http://[${scoped[1]}]`).hostname)}%${Number(scoped[2])}`}catch{/* не разобралось как IPv6 со зоной: ниже обычный путь */}
    return `invalid:${trimmed.toLowerCase()}`;
  }
}

/** Human-readable host without destroying IPv6 addresses by splitting on ':'. */
export function printerHostDisplay(value:string){
  const trimmed=value.trim();
  if(!trimmed)return'';
  try{
    const url=new URL(/^https?:\/\//i.test(trimmed)?trimmed:`http://${trimmed}`);
    return url.hostname.replace(/^\[|\]$/g,'');
  }catch{
    const bracketed=trimmed.match(/^\[([^\]]+)\](?::\d+)?$/);
    if(bracketed)return bracketed[1];
    const ipv4Port=trimmed.match(/^([^:]+):\d+$/);
    return ipv4Port?.[1]??trimmed;
  }
}

export function printerPort(value:string,defaultPort=7125){
  const trimmed=value.trim();
  const specified=explicitPort(trimmed);
  if(specified)return specified;
  try{
    const url=new URL(/^https?:\/\//i.test(trimmed)?trimmed:`http://${trimmed}`);
    return Number(url.port)||defaultPort;
  }catch{
    const bracketed=trimmed.match(/^\[[^\]]+\]:(\d+)$/),ipv4=trimmed.match(/:(\d+)$/);
    const port=Number(bracketed?.[1]??ipv4?.[1]);
    return Number.isInteger(port)&&port>0&&port<=65535?port:defaultPort;
  }
}
