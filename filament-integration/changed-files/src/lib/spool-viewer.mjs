/* Klipper Farm filament viewer. Derived from the user-approved card.
 * No inventory, network, printer commands, persistence, or external libraries.
 * See 02-INTEGRATION-RU.md for the data and lifecycle contract.
 */
'use strict';
function normalizeSpool(input){
  if(!input||typeof input!=='object')throw new TypeError('Передайте описание катушки');
  const material=String(input.material||input.type||'').trim();
  if(!material)throw new TypeError('Нужен материал катушки');
  const color=String(input.color||'');
  if(!/^#[0-9a-f]{6}$/i.test(color))throw new TypeError('Цвет должен иметь вид #RRGGBB');
  const grams=Number(input.grams),capacityGrams=Number(input.capacityGrams??1000),diameterMM=Number(input.diameterMM??1.75);
  if(!Number.isFinite(grams)||grams<0)throw new TypeError('Остаток должен быть неотрицательным числом');
  if(!Number.isFinite(capacityGrams)||capacityGrams<=0)throw new TypeError('Нужна положительная ёмкость катушки');
  if(!Number.isFinite(diameterMM)||diameterMM<=0)throw new TypeError('Нужен положительный диаметр нити');
  const finishes={silk:1,normal:.55,matte:.1};
  const finish=typeof input.finish==='string'&&input.finish in finishes?finishes[input.finish]:Number(input.finish??.55);
  if(!Number.isFinite(finish)||finish<0||finish>1)throw new TypeError('Поверхность: silk, normal, matte или число 0…1');
  let barcode=input.barcode==null?'':String(input.barcode);
  if(barcode){if(!/^\d{8}$/.test(barcode))throw new TypeError('Для этикетки поддерживается восьмизначный EAN-8');const sum=[...barcode.slice(0,7)].reduce((s,c,i)=>s+Number(c)*(i%2?1:3),0);if((10-sum%10)%10!==Number(barcode[7]))throw new TypeError('Неверная контрольная цифра EAN-8');}
  const ordinal=input.ordinal==null?null:Number(input.ordinal);
  if(ordinal!==null&&(!Number.isInteger(ordinal)||ordinal<1||ordinal>9999))throw new TypeError('Номер катушки: целое 1…9999');
  return{id:String(input.id??''),material,color,grams,capacityGrams,diameterMM,finish,serial:input.serial==null?'':String(input.serial),lot:input.lot==null?'':String(input.lot),barcode,ordinal};
}
function formatCapacity(grams){return String(Number((grams/1000).toFixed(3)))+' KG';}
function createFilamentSpool(canvas,options={}){
  if(!canvas||typeof canvas.getContext!=='function')throw new TypeError('Нужен элемент canvas');
  const root=canvas,ownedShaders=[];
  let current=normalizeSpool(options.spool),selected={type:current.material,finish:current.finish},labelOrdinal=current.ordinal||1;
  let inspector=options.mode==='inspect',pixelRatioCap=Math.max(1,Math.min(2,Number(options.pixelRatioCap)||2));
  const initialView={yaw:-.80,pitch:.21,roll:-.075,zoom:1,...options.view};
  for(const key of ['yaw','pitch','roll','zoom'])if(!Number.isFinite(initialView[key]))throw new TypeError('Некорректный ракурс: '+key);
  initialView.zoom=Math.max(.8,Math.min(1.9,initialView.zoom));
  let disposed=false,contextLost=false,drag=null,dragFrame=0;
  function serial(){return current.serial;}
  const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false,preserveDrawingBuffer:true});
  if(!gl)throw new Error('WebGL недоступен: покажите резервное изображение катушки');
  // A reused canvas can retain enabled attributes pointing at deleted buffers.
  for(let i=0;i<gl.getParameter(gl.MAX_VERTEX_ATTRIBS);i++)gl.disableVertexAttribArray(i);
  const derivatives=!!gl.getExtension('OES_standard_derivatives');
  const vs=`attribute vec3 aPosition;attribute vec3 aNormal;attribute vec2 aStrand;uniform mat3 uRotation;
  uniform mat4 uLightMatrix;uniform float uAspect;uniform float uZoom;uniform float uKind;
  varying vec3 vPosition;varying vec3 vNormal;varying vec3 vLocal;varying vec3 vLocalNormal;varying vec4 vShadow;varying vec2 vStrand;
  void main(){vec3 p=uKind>4.5&&uKind<5.5?aPosition:uRotation*aPosition;vPosition=p;vNormal=uRotation*aNormal;vLocal=aPosition;vLocalNormal=aNormal;vStrand=aStrand;vShadow=uLightMatrix*vec4(p,1.);float z=4.9-p.z;gl_Position=vec4(p.x*3.65*uZoom/uAspect,(p.y+.045)*3.65*uZoom,1.004*z-.2004,z);}`;
  const fs=`${derivatives?'#extension GL_OES_standard_derivatives : enable\n':''}precision highp float;
  varying vec3 vPosition;varying vec3 vNormal;varying vec3 vLocal;varying vec3 vLocalNormal;varying vec4 vShadow;varying vec2 vStrand;
  uniform vec3 uColor;uniform float uKind;uniform float uGloss;uniform mat3 uRotation;uniform float uWoundRadius;uniform float uTransmission;
  uniform vec2 uViewport;uniform vec3 uFilamentColor;uniform float uZoom;
  uniform sampler2D uLabel;uniform sampler2D uPrint;uniform sampler2D uShadowMap;uniform float uShadowOn;
  const float PI=3.14159265;
  float random(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
  vec3 surfaceNoise(vec2 p){vec2 cell=floor(p),f=fract(p),u=f*f*(3.-2.*f),du=6.*f*(1.-f);float a=random(vec3(cell,1.)),b=random(vec3(cell+vec2(1.,0.),1.)),c=random(vec3(cell+vec2(0.,1.),1.)),d=random(vec3(cell+vec2(1.),1.));return vec3(mix(mix(a,b,u.x),mix(c,d,u.x),u.y),mix(b-a,d-c,u.y)*du.x,mix(c-a,d-b,u.x)*du.y);}
  float shadowAt(float ndl){
    if(uShadowOn<.5)return 1.;vec3 p=vShadow.xyz/vShadow.w*.5+.5;
    if(p.x<.002||p.x>.998||p.y<.002||p.y>.998||p.z>1.)return 1.;
    float bias=max(.00024,.00075*(1.-ndl)),sum=0.;
    float softness=.00068;
    if(uKind>4.5&&uKind<5.5){float blockers=0.,depthSum=0.;for(int bx=-1;bx<=1;bx++)for(int by=-1;by<=1;by++){float sampleZ=dot(texture2D(uShadowMap,p.xy+vec2(float(bx),float(by))*.006),vec4(1./16777216.,1./65536.,1./256.,1.));if(sampleZ<p.z-bias){depthSum+=sampleZ;blockers+=1.;}}if(blockers<.5)return 1.;softness=clamp((p.z-depthSum/blockers)*.062,.0011,.0045);}
    for(int x=-2;x<=2;x++)for(int y=-2;y<=2;y++){
      vec4 depthSample=texture2D(uShadowMap,p.xy+vec2(float(x),float(y))*softness);
      float depth=dot(depthSample,vec4(1./16777216.,1./65536.,1./256.,1.));sum+=p.z-bias<=depth?1.:0.;
    }return sum/25.;
  }
  vec3 fresnel(float h,vec3 f0){return f0+(1.-f0)*pow(1.-h,5.);}
  vec3 directBRDF(vec3 n,vec3 specNormal,vec3 v,vec3 l,vec3 base,float rough,float metal,vec3 f0,vec3 tangent,float anisotropy){
    vec3 h=normalize(v+l);float nl=max(dot(n,l),0.),specNL=max(dot(specNormal,l),0.),nv=max(dot(specNormal,v),.001),nh=max(dot(specNormal,h),0.),vh=max(dot(v,h),0.);
    float a=rough*rough,a2=a*a,d=nh*nh*(a2-1.)+1.,distribution=a2/(PI*d*d+.00001);
    if(anisotropy>.01){vec3 t=normalize(tangent-specNormal*dot(tangent,specNormal)),b=normalize(cross(specNormal,t));float ax=max(.045,a*(1.-anisotropy*.40)),ay=max(.055,a*(1.+anisotropy*1.8));float ht=dot(h,t)/ax,hb=dot(h,b)/ay,q=ht*ht+hb*hb+nh*nh;distribution=1./(PI*ax*ay*q*q+.00001);}
    float k=(rough+1.)*(rough+1.)/8.,g=(nv/(nv*(1.-k)+k))*(specNL/(specNL*(1.-k)+k));
    vec3 f=fresnel(vh,f0),spec=distribution*g*f/(4.*nv*specNL+.001),diff=(1.-f)*(1.-metal)*base/PI;
    return diff*nl+spec*specNL;
  }
  float boxReflection(vec3 r,vec3 aim,float width,float height,float blur){
    vec3 direction=normalize(aim),right=normalize(cross(vec3(0.,1.,0.),direction)),up=cross(direction,right);float forward=dot(r,direction);
    if(forward<=0.)return 0.;vec2 uv=vec2(dot(r,right),dot(r,up))/forward;float e=max(abs(uv.x)/width,abs(uv.y)/height);
    return 1.-smoothstep(1.-blur,1.+blur,e);
  }
  void main(){
    float r=length(vLocal.xy);float theta=atan(vLocal.y,vLocal.x);
    bool body=uKind<.5||(uKind>6.5&&uKind<7.5);bool wire=uKind>3.5&&uKind<4.5;bool thread=(uKind>.5&&uKind<1.5)||wire;bool paper=uKind>2.5&&uKind<3.5;
    bool steel=(uKind>1.5&&uKind<2.5)||(uKind>7.5&&uKind<8.5);
    if(uKind<.5&&r>.97&&r<1.055&&abs(vLocal.z)>.42){float a=mod(theta+6.2831853,.7853982)-.3926991;if(length(vec2(r-1.015,a*1.015))<.013)discard;}
    if(uKind<.5&&r>.55&&r<.84&&abs(vLocal.z)>.425){float a=mod(theta+6.6758844,.7853982)-.3926991;vec2 q=vec2(r*cos(a),r*sin(a));if(length(vec2(q.x-clamp(q.x,.60,.79),q.y))<.0235)discard;}
    if(uKind>1.5&&uKind<2.5){float a=mod(theta+6.6758844,.7853982)-.3926991;vec2 d=vec2(r*cos(a)-.438,r*sin(a));if(max(abs(d.x)*.8660254+abs(d.y)*.5,abs(d.y))<.0044)discard;}
    if(uKind>4.5&&uKind<5.5){float s=1.-shadowAt(.65);float fade=exp(-.48*(vLocal.x*vLocal.x+vLocal.z*vLocal.z));float contact=.095*exp(-2.6*vLocal.x*vLocal.x-3.6*vLocal.z*vLocal.z);vec2 edge=min(gl_FragCoord.xy/uViewport,1.-gl_FragCoord.xy/uViewport);float edgeFade=smoothstep(0.,.11,min(edge.x,edge.y));gl_FragColor=vec4(0.,0.,0.,(s*.22*fade+contact)*edgeFade);return;}
    vec3 localN=normalize(vLocalNormal);
    float grain=random(floor(vLocal*1900.));
    float pores=random(floor(vLocal*510.));
    vec2 moldUV=abs(vLocalNormal.z)>.5?vLocal.xy:vec2(theta*r,vLocal.z);vec3 mold=vec3(.5,0.,0.);if(body)mold=surfaceNoise(moldUV*160.);
    localN=normalize(localN+vec3(grain-.5,random(floor(vLocal.zxy*2200.))-.5,pores-.5)*(body?.010:steel?.004:paper?.007:.0014));
    if(body){vec3 slope=abs(vLocalNormal.z)>.5?vec3(mold.yz,0.):vec3(-sin(theta)*mold.y,cos(theta)*mold.y,mold.z);localN=normalize(localN-slope*.013);}
    float strandTexture=0.,strandVariation=1.;
    if(wire){float filtering=${derivatives?'1.-smoothstep(.035,.09,fwidth(vStrand.x))':'0.'};float phase=vStrand.x*56.5486678+.22*sin(vStrand.y*.32);strandTexture=sin(phase)*filtering;vec3 tangentLocal=normalize(vec3(-sin(theta),cos(theta),.003));localN=normalize(localN+cross(tangentLocal,localN)*cos(phase)*filtering*.012);strandVariation=.98+.02*surfaceNoise(vec2(vStrand.y*.13,.7)).x;}
    vec3 n=normalize(uRotation*localN);vec3 v=normalize(vec3(0.,0.,4.9)-vPosition);if(dot(n,v)<0.)n=-n;
    vec3 base=pow(uColor,vec3(2.2));float ink=0.;
    if(paper){vec2 uv=vLocal.xy/.88+vec2(.5);if(vLocal.z<0.)uv.x=1.-uv.x;base=pow(texture2D(uLabel,vec2(uv.x,1.-uv.y)).rgb,vec3(2.2));base*=1.-.12*smoothstep(.413,.419,r);}
    if(body&&abs(vLocal.z)>.509&&abs(vLocalNormal.z)>.5&&r>.47){vec2 uv=vLocal.xy/2.22+vec2(.5);if(vLocal.z<0.)uv.x=1.-uv.x;uv.y=1.-uv.y;vec4 decal=texture2D(uPrint,uv);ink=decal.a;base=mix(base,pow(decal.rgb,vec3(2.2)),ink);float dx=texture2D(uPrint,uv+vec2(.001,0.)).a-texture2D(uPrint,uv-vec2(.001,0.)).a,dy=texture2D(uPrint,uv+vec2(0.,.001)).a-texture2D(uPrint,uv-vec2(0.,.001)).a;n=normalize(n+uRotation*vec3(-dx,dy,0.)*.10);}
    if(thread){float facing=clamp(dot(n,v),0.,1.);vec3 pearl=mix(base,sqrt(base)*.70,uGloss*.09*pow(1.-facing,2.));base=pearl*strandVariation;if(!wire)base*=.74;}
    float edgePolish=body?smoothstep(.15,.85,1.-abs(vLocalNormal.z))*smoothstep(1.04,1.08,r):0.;
    float rough=thread?mix(.70,.30,uGloss)+strandTexture*.012:paper?.78:steel?.25:mix(.44,.27,edgePolish)+(mold.x-.5)*.055;rough=mix(rough,.56,ink);
    ${derivatives?'vec3 dxN=dFdx(n),dyN=dFdy(n);float normalVariance=.14*(dot(dxN,dxN)+dot(dyN,dyN));rough=min(.88,sqrt(rough*rough+min(.14,normalVariance)));':''}
    float metal=steel?.88:thread?uGloss*.34:0.;vec3 f0=mix(vec3(.04),base,metal);
    vec3 tangent=uRotation*vec3(-sin(theta),cos(theta),.002);tangent=normalize(tangent-n*dot(tangent,n));float anisotropy=thread?uGloss*.50:0.;
    vec3 l=normalize(vec3(-3.5,5.,5.)),l2=normalize(vec3(2.,1.1,3.5)),l3=normalize(vec3(-2.,-.5,1.));
    float visibility=shadowAt(max(0.,dot(n,l))),ao=thread?mix(.72,1.,smoothstep(.445,.57,r)):1.;if(body&&r<.245)ao=.5;
    vec3 glossNormal=n;
    if(wire){vec3 envelope=abs(vLocal.z)>.397&&r<uWoundRadius-.012?vec3(0.,0.,sign(vLocal.z)):vec3(cos(theta),sin(theta),0.);float outward=clamp(dot(localN,envelope),0.,1.);ao*=mix(.66,1.,sqrt(outward));vec3 macro=normalize(uRotation*envelope);if(dot(macro,v)<0.)macro=-macro;float pixelWorld=(4.9-vPosition.z)*2./(3.65*uZoom*uViewport.y),footprint=smoothstep(.03,.13,pixelWorld/.0174);glossNormal=normalize(mix(n,macro,footprint*.88));}
    vec3 lit=base*(.22+.045*n.y)*ao;
    if(body&&r>.43&&r<1.04&&abs(vLocal.z)>.40){float targetR=clamp(r,.445,uWoundRadius);vec3 delta=vec3((targetR-r)*cos(theta),(targetR-r)*sin(theta),clamp(vLocal.z,-.399,.399)-vLocal.z);float distance=max(length(delta),.001),form=max(dot(localN,delta/distance),0.)*exp(-distance*10.);lit+=base*pow(uFilamentColor,vec3(2.2))*form*1.1;}
    lit+=directBRDF(n,glossNormal,v,l,base,rough,metal,f0,tangent,anisotropy)*vec3(3.6,3.35,3.10)*mix(.10,1.,visibility);
    lit+=directBRDF(n,glossNormal,v,l2,base,rough,metal,f0,tangent,anisotropy)*vec3(1.18,1.36,1.66);
    lit+=directBRDF(n,glossNormal,v,l3,base,rough,metal,f0,tangent,anisotropy)*vec3(.70,.74,.82);
    vec3 reflected=reflect(-v,glossNormal);float blur=.12+rough*.8;
    float key=boxReflection(reflected,vec3(-2.,2.7,3.5),.5,1.05,blur),strip=boxReflection(reflected,vec3(2.8,1.,4.),.20,1.25,blur);
    vec3 env=fresnel(max(dot(n,v),0.),f0)*(vec3(1.,.96,.89)*key+vec3(.68,.8,1.)*strip)*mix(1.5,.5,rough);
    lit+=env;
    if(wire){vec3 backLight=normalize(vec3(2.8,2.5,-3.2));float through=pow(max(dot(-n,backLight),0.),1.6);float rim=pow(1.-max(dot(n,v),0.),2.5);vec3 transmitted=mix(base,sqrt(base)*.55,.28);lit+=transmitted*(through*.75+rim*.22)*uTransmission;float silkHighlight=pow(sqrt(max(0.,1.-pow(dot(tangent,normalize(v+l2)),2.))),55.);lit+=mix(vec3(.16),base*.38,.60)*silkHighlight*uGloss*max(dot(n,l2),0.);vec3 coat=directBRDF(n,glossNormal,v,l2,vec3(0.),max(.32,rough+.06),1.,vec3(.04),tangent,.18)*vec3(1.1,1.18,1.3);lit+=(coat*.45+vec3(.035)*strip)*uGloss;lit*=mix(.88,1.,ao);}
    lit*=.994+.012*grain;
    float peak=max(lit.r,max(lit.g,lit.b));float mapped=(peak*(2.51*peak+.03))/(peak*(2.43*peak+.59)+.14);lit=clamp(lit*mapped/max(peak,.0001),0.,1.);
    gl_FragColor=vec4(pow(lit,vec3(1./2.2)),1.);
  }`;
  function shader(kind,source){const s=gl.createShader(kind);ownedShaders.push(s);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
  const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,vs));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fs));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);
  const loc={};['aPosition','aNormal','aStrand'].forEach(n=>loc[n]=gl.getAttribLocation(program,n));['uRotation','uLightMatrix','uAspect','uZoom','uColor','uKind','uGloss','uLabel','uPrint','uShadowMap','uShadowOn','uViewport','uWoundRadius','uTransmission','uFilamentColor'].forEach(n=>loc[n]=gl.getUniformLocation(program,n));
  gl.enable(gl.DEPTH_TEST);gl.clearColor(0,0,0,0);
  const shadowVS=`attribute vec3 aPosition;uniform mat3 uRotation;uniform mat4 uLightMatrix;varying vec3 vLocal;void main(){vLocal=aPosition;gl_Position=uLightMatrix*vec4(uRotation*aPosition,1.);}`;
  const shadowFS=`precision highp float;varying vec3 vLocal;uniform float uKind;
  void main(){float r=length(vLocal.xy),theta=atan(vLocal.y,vLocal.x);
  if(uKind<.5&&r>.97&&r<1.055&&abs(vLocal.z)>.42){float a=mod(theta+6.2831853,.7853982)-.3926991;if(length(vec2(r-1.015,a*1.015))<.013)discard;}
  if(uKind<.5&&r>.55&&r<.84&&abs(vLocal.z)>.425){float a=mod(theta+6.6758844,.7853982)-.3926991;vec2 q=vec2(r*cos(a),r*sin(a));if(length(vec2(q.x-clamp(q.x,.60,.79),q.y))<.0235)discard;}
  if(uKind>1.5&&uKind<2.5){float a=mod(theta+6.6758844,.7853982)-.3926991;vec2 d=vec2(r*cos(a)-.438,r*sin(a));if(max(abs(d.x)*.8660254+abs(d.y)*.5,abs(d.y))<.0044)discard;}
  vec4 encodedDepth=fract(gl_FragCoord.z*vec4(16777216.,65536.,256.,1.));encodedDepth-=encodedDepth.xxyz*vec4(0.,1./256.,1./256.,1./256.);gl_FragColor=encodedDepth;}`;
  const shadowProgram=gl.createProgram();gl.attachShader(shadowProgram,shader(gl.VERTEX_SHADER,shadowVS));gl.attachShader(shadowProgram,shader(gl.FRAGMENT_SHADER,shadowFS));gl.linkProgram(shadowProgram);if(!gl.getProgramParameter(shadowProgram,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(shadowProgram));
  const shadowLoc={position:gl.getAttribLocation(shadowProgram,'aPosition'),rotation:gl.getUniformLocation(shadowProgram,'uRotation'),matrix:gl.getUniformLocation(shadowProgram,'uLightMatrix'),kind:gl.getUniformLocation(shadowProgram,'uKind')};
  function cross(a,b){return[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
  function matMultiply(a,b){const out=new Float32Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)out[c*4+r]+=a[k*4+r]*b[c*4+k];return out;}
  const lightEye=[-3.5,5,5],lz=norm(lightEye),lx=norm(cross([0,1,0],lz)),ly=cross(lz,lx),dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
  const lightView=[lx[0],ly[0],lz[0],0,lx[1],ly[1],lz[1],0,lx[2],ly[2],lz[2],0,-dot(lx,lightEye),-dot(ly,lightEye),-dot(lz,lightEye),1];
  const lightProjection=[1/2.2,0,0,0,0,1/2.2,0,0,0,0,-2/11.9,0,0,0,-12.1/11.9,1],lightMatrix=matMultiply(lightProjection,lightView);
  const shadowSize=2048,shadowTexture=gl.createTexture(),shadowFBO=gl.createFramebuffer(),shadowDepth=gl.createRenderbuffer();
  gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,shadowTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,shadowSize,shadowSize,0,gl.RGBA,gl.UNSIGNED_BYTE,null);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER,shadowFBO);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,shadowTexture,0);gl.bindRenderbuffer(gl.RENDERBUFFER,shadowDepth);gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,shadowSize,shadowSize);gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,shadowDepth);const shadowReady=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindRenderbuffer(gl.RENDERBUFFER,null);gl.useProgram(program);gl.uniform1i(loc.uShadowMap,2);gl.uniformMatrix4fv(loc.uLightMatrix,false,lightMatrix);
  const depthExtension=gl.getExtension('WEBGL_depth_texture');
  const postVS=`attribute vec2 aScreen;varying vec2 vUV;void main(){vUV=aScreen*.5+.5;gl_Position=vec4(aScreen,0.,1.);}`;
  const postFS=`precision highp float;varying vec2 vUV;uniform sampler2D uScene;uniform sampler2D uDepth;uniform vec2 uSize;uniform float uFocal;uniform float uAspect;
  vec3 positionAt(vec2 uv){float depth=texture2D(uDepth,uv).r;float z=.2004/(2.004-2.*depth);return vec3((uv.x*2.-1.)*z*uAspect/uFocal,(uv.y*2.-1.)*z/uFocal,-z);}
  float ambientContact(vec2 uv){
    if(texture2D(uDepth,uv).r>.9999)return 1.;vec2 texel=1./uSize;vec3 p=positionAt(uv);
    vec3 left=p-positionAt(uv-vec2(texel.x,0.)),right=positionAt(uv+vec2(texel.x,0.))-p,down=p-positionAt(uv-vec2(0.,texel.y)),up=positionAt(uv+vec2(0.,texel.y))-p;
    vec3 dx=abs(left.z)<abs(right.z)?left:right,dy=abs(down.z)<abs(up.z)?down:up,n=normalize(cross(dx,dy));if(n.z<0.)n=-n;
    float radius=.085,ao=0.;vec2 projected=vec2(1./uAspect,1.)*radius*uFocal/(-p.z*2.);
    float rotation=fract(sin(dot(floor(gl_FragCoord.xy*.5),vec2(12.9898,78.233)))*43758.5453)*6.2831853;
    for(int i=0;i<12;i++){float t=(float(i)+.5)/12.,a=float(i)*2.3999632+rotation;vec2 offset=vec2(cos(a),sin(a))*sqrt(t)*projected;vec3 delta=positionAt(uv+offset)-p;float distance=length(delta);float range=max(0.,1.-distance/radius);if(distance>.002)ao+=max(0.,dot(n,delta/distance)-.13)*range*range;}
    return 1.-min(.34,ao*.30);
  }
  float luminance(vec4 c){return dot(c.rgb,vec3(.299,.587,.114))+c.a*.08;}
  vec4 antialias(vec2 uv){
    vec2 texel=1./uSize;vec4 center=texture2D(uScene,uv),nw=texture2D(uScene,uv+vec2(-1.,1.)*texel),ne=texture2D(uScene,uv+texel),sw=texture2D(uScene,uv-texel),se=texture2D(uScene,uv+vec2(1.,-1.)*texel);
    if(min(center.a,min(min(nw.a,ne.a),min(sw.a,se.a)))>.999){float z=positionAt(uv).z;float dz=max(max(abs(positionAt(uv+vec2(-1.,1.)*texel).z-z),abs(positionAt(uv+texel).z-z)),max(abs(positionAt(uv-texel).z-z),abs(positionAt(uv+vec2(1.,-1.)*texel).z-z)));if(dz<.028)return center;}
    float lm=luminance(center),lnw=luminance(nw),lne=luminance(ne),lsw=luminance(sw),lse=luminance(se),lo=min(lm,min(min(lnw,lne),min(lsw,lse))),hi=max(lm,max(max(lnw,lne),max(lsw,lse)));
    if(hi-lo<max(.025,hi*.10))return center;
    vec2 direction=vec2(-((lnw+lne)-(lsw+lse)),(lnw+lsw)-(lne+lse));float reduce=max((lnw+lne+lsw+lse)*.03125,.0078125);direction=clamp(direction/(min(abs(direction.x),abs(direction.y))+reduce),vec2(-6.),vec2(6.))*texel;
    vec4 a=.5*(texture2D(uScene,uv+direction*(-.1666667))+texture2D(uScene,uv+direction*.1666667)),b=a*.5+.25*(texture2D(uScene,uv-direction*.5)+texture2D(uScene,uv+direction*.5));float lb=luminance(b);return lb<lo||lb>hi?a:b;
  }
  void main(){vec4 color=antialias(vUV);float contact=ambientContact(vUV);vec3 rgb=color.rgb/max(color.a,.0001);rgb*=pow(contact,1./2.2);gl_FragColor=vec4(rgb,color.a);}`;
  let postProgram=null,postLoc=null,postFBO=null,postColor=null,postDepth=null,postTriangle=null,postWidth=0,postHeight=0,postReady=false;
  if(depthExtension){
    postProgram=gl.createProgram();gl.attachShader(postProgram,shader(gl.VERTEX_SHADER,postVS));gl.attachShader(postProgram,shader(gl.FRAGMENT_SHADER,postFS));gl.linkProgram(postProgram);if(!gl.getProgramParameter(postProgram,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(postProgram));
    postLoc={screen:gl.getAttribLocation(postProgram,'aScreen')};for(const name of ['uScene','uDepth','uSize','uFocal','uAspect'])postLoc[name]=gl.getUniformLocation(postProgram,name);
    postFBO=gl.createFramebuffer();postColor=gl.createTexture();postDepth=gl.createTexture();postTriangle=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,postTriangle);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
    gl.useProgram(postProgram);gl.uniform1i(postLoc.uScene,3);gl.uniform1i(postLoc.uDepth,4);gl.useProgram(program);
  }
  function preparePost(width,height){
    if(!depthExtension)return false;if(width===postWidth&&height===postHeight)return postReady;postWidth=width;postHeight=height;
    for(const [unit,texture,format,type,filter] of [[gl.TEXTURE3,postColor,gl.RGBA,gl.UNSIGNED_BYTE,gl.LINEAR],[gl.TEXTURE4,postDepth,gl.DEPTH_COMPONENT,gl.UNSIGNED_INT,gl.NEAREST]]){
      gl.activeTexture(unit);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,format,width,height,0,format,type,null);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,postFBO);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,postColor,0);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,postDepth,0);postReady=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;gl.bindFramebuffer(gl.FRAMEBUFFER,null);return postReady;
  }
  function finishPost(width,height,viewZoom){
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,width,height);gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);gl.useProgram(postProgram);gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,postColor);gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_2D,postDepth);gl.uniform2f(postLoc.uSize,width,height);gl.uniform1f(postLoc.uFocal,3.65*viewZoom);gl.uniform1f(postLoc.uAspect,width/height);gl.bindBuffer(gl.ARRAY_BUFFER,postTriangle);gl.enableVertexAttribArray(postLoc.screen);gl.vertexAttribPointer(postLoc.screen,2,gl.FLOAT,false,8,0);gl.drawArrays(gl.TRIANGLES,0,3);gl.enable(gl.DEPTH_TEST);gl.useProgram(program);
  }
  let lastShadowKey='';
  let yaw=initialView.yaw,pitch=initialView.pitch,roll=initialView.roll,color=current.color,weight=Math.min(1,current.grams/current.capacityGrams)*1000,gloss=current.finish,zoom=initialView.zoom,booting=true,interacting=false;
  function norm(v){const l=Math.hypot(...v)||1;return v.map(x=>x/l);}
  function addVertex(out,p,n){out.push(...p,...n);}
  function quad(out,a,b,c,d,na,nb,nc,nd){addVertex(out,a,na);addVertex(out,b,nb);addVertex(out,c,nc);addVertex(out,a,na);addVertex(out,c,nc);addVertex(out,d,nd);}
  function lathe(out,profile,steps=128,start=0,span=Math.PI*2,cx=0,cy=0){
    const at=(r,z,a)=>[cx+r*Math.cos(a),cy+r*Math.sin(a),z];
    const edgeNormals=profile.map((p,j)=>{const q=profile[(j+1)%profile.length];return norm([q[1]-p[1],p[0]-q[0]]);});
    for(let j=0;j<profile.length;j++){
      const p=profile[j],q=profile[(j+1)%profile.length],dr=q[0]-p[0],dz=q[1]-p[1],n=norm([dz,-dr]);
      const previous=edgeNormals[(j+profile.length-1)%profile.length],next=edgeNormals[(j+1)%profile.length],np=dot(previous,n)>.5?norm(n.map((v,i)=>v+previous[i])):n,nq=dot(next,n)>.5?norm(n.map((v,i)=>v+next[i])):n;
      for(let i=0;i<steps;i++){const a=start+span*i/steps,b=start+span*(i+1)/steps;const pna=[np[0]*Math.cos(a),np[0]*Math.sin(a),np[1]],pnb=[np[0]*Math.cos(b),np[0]*Math.sin(b),np[1]],qna=[nq[0]*Math.cos(a),nq[0]*Math.sin(a),nq[1]],qnb=[nq[0]*Math.cos(b),nq[0]*Math.sin(b),nq[1]];quad(out,at(p[0],p[1],a),at(p[0],p[1],b),at(q[0],q[1],b),at(q[0],q[1],a),pna,pnb,qnb,qna);}
    }
    if(span<Math.PI*2-.001){
      const lo=profile[0][0],hi=Math.max(...profile.map(x=>x[0])),z0=Math.min(...profile.map(x=>x[1])),z1=Math.max(...profile.map(x=>x[1]));
      for(const [a,sgn] of [[start,-1],[start+span,1]]){const n=[-Math.sin(a)*sgn,Math.cos(a)*sgn,0];quad(out,at(lo,z0,a),at(hi,z0,a),at(hi,z1,a),at(lo,z1,a),n,n,n,n);}
    }
  }
  function ring(out,ri,ro,z,depth,steps=128,start=0,span=Math.PI*2,cx=0,cy=0){const b=Math.min(.009,(ro-ri)/4,depth/3);lathe(out,[[ri,z-depth/2],[ro-b,z-depth/2],[ro,z-depth/2+b],[ro,z+depth/2-b],[ro-b,z+depth/2],[ri,z+depth/2]],steps,start,span,cx,cy);}
  function roundedSpoke(out,ri,ro,z,depth,start,span){
    const rm=(ri+ro)/2,va=start*rm,vb=(start+span)*rm,rad=.028,outline=[];
    const corners=[[ro-rad,vb-rad,0],[ri+rad,vb-rad,Math.PI/2],[ri+rad,va+rad,Math.PI],[ro-rad,va+rad,Math.PI*1.5]];
    for(const [u,v,a] of corners)for(let k=0;k<=5;k++){const r=u+rad*Math.cos(a+k*Math.PI/10),theta=(v+rad*Math.sin(a+k*Math.PI/10))/rm;outline.push([r*Math.cos(theta),r*Math.sin(theta)]);}
    const center=[0,0];for(const p of outline){center[0]+=p[0]/outline.length;center[1]+=p[1]/outline.length;}
    const inner=outline.map(p=>[center[0]+(p[0]-center[0])*.94,center[1]+(p[1]-center[1])*.91]);
    const point=(p,zz)=>[p[0],p[1],zz],front=[0,0,1],back=[0,0,-1],bevel=.011;
    const normals=outline.map((p,i)=>{const prev=outline[(i+outline.length-1)%outline.length],next=outline[(i+1)%outline.length],a=norm([p[1]-prev[1],prev[0]-p[0]]),b=norm([next[1]-p[1],p[0]-next[0]]);return norm([a[0]+b[0],a[1]+b[1],0]);});
    for(let i=0;i<outline.length;i++){
      const j=(i+1)%outline.length,p=outline[i],q=outline[j],a=inner[i],b=inner[j];
      const np=normals[i],nq=normals[j];
      addVertex(out,point(center,z+depth/2),front);addVertex(out,point(a,z+depth/2),front);addVertex(out,point(b,z+depth/2),front);
      addVertex(out,point(center,z-depth/2),back);addVertex(out,point(b,z-depth/2),back);addVertex(out,point(a,z-depth/2),back);
      quad(out,point(p,z-depth/2+bevel),point(q,z-depth/2+bevel),point(q,z+depth/2-bevel),point(p,z+depth/2-bevel),np,nq,nq,np);
      for(const sign of [-1,1])for(let step=0;step<5;step++){
        const t0=step*Math.PI/10,t1=(step+1)*Math.PI/10;
        const at=(inside,outside,t)=>[inside[0]+(outside[0]-inside[0])*Math.sin(t),inside[1]+(outside[1]-inside[1])*Math.sin(t),z+sign*(depth/2-bevel*(1-Math.cos(t)))];
        const normal=(n,t)=>[n[0]*Math.sin(t),n[1]*Math.sin(t),sign*Math.cos(t)];
        quad(out,at(a,p,t0),at(b,q,t0),at(b,q,t1),at(a,p,t1),normal(np,t0),normal(nq,t0),normal(nq,t1),normal(np,t1));
      }
    }
  }
  function curveTube(out,points,radius,sides=8,coordinates=null){
    const frames=points.map((p,i)=>{const prev=points[Math.max(0,i-1)],next=points[Math.min(points.length-1,i+1)],t=norm(next.map((v,k)=>v-prev[k]));const n=norm(cross(t,Math.abs(t[2])<.96?[0,0,1]:[1,0,0])),b=cross(t,n);return{n,b};});
    const arc=[0];if(coordinates)for(let i=1;i<points.length;i++)arc.push(arc[i-1]+Math.hypot(...points[i].map((v,k)=>v-points[i-1][k])));
    const normal=(f,t)=>f.n.map((v,i)=>v*Math.cos(t)+f.b[i]*Math.sin(t));
    for(let j=0;j<points.length-1;j++)for(let k=0;k<sides;k++){
      const t0=k*Math.PI*2/sides,t1=(k+1)*Math.PI*2/sides,n0=normal(frames[j],t0),n1=normal(frames[j],t1),n2=normal(frames[j+1],t1),n3=normal(frames[j+1],t0),p=points[j],q=points[j+1];
      quad(out,p.map((v,i)=>v+n0[i]*radius),p.map((v,i)=>v+n1[i]*radius),q.map((v,i)=>v+n2[i]*radius),q.map((v,i)=>v+n3[i]*radius),n0,n1,n2,n3);
      if(coordinates){const u0=k/sides,u1=(k+1)/sides,v0=arc[j],v1=arc[j+1];coordinates.push(u0,v0,u1,v0,u1,v1,u0,v0,u1,v1,u0,v1);}
    }
  }
  function slotRim(out,z,angle){
    const profile=[[.018,z-.028],[.023,z-.040],[.029,z-.040],[.029,z+.040],[.023,z+.040],[.018,z+.028]],outline=[];
    for(const [cx,start] of [[.79,-Math.PI/2],[.60,Math.PI/2]])for(let k=0;k<=16;k++){const a=start+k*Math.PI/16;outline.push([cx,Math.cos(a),Math.sin(a)]);}
    const ca=Math.cos(angle),sa=Math.sin(angle),at=(p,w,zz)=>[(p[0]+w*p[1])*ca-w*p[2]*sa,(p[0]+w*p[1])*sa+w*p[2]*ca,zz];
    const normal=(p,n)=>[(p[1]*ca-p[2]*sa)*n[0],(p[1]*sa+p[2]*ca)*n[0],n[1]];
    const normals=profile.map((p,j)=>{const q=profile[(j+1)%profile.length];return norm([q[1]-p[1],p[0]-q[0]]);});
    for(let j=0;j<profile.length;j++){
      const p=profile[j],q=profile[(j+1)%profile.length],n=normals[j],prev=normals[(j+profile.length-1)%profile.length],next=normals[(j+1)%profile.length];
      const np=dot(prev,n)>.3?norm(n.map((v,i)=>v+prev[i])):n,nq=dot(next,n)>.3?norm(n.map((v,i)=>v+next[i])):n;
      for(let k=0;k<outline.length;k++){const a=outline[k],b=outline[(k+1)%outline.length];quad(out,at(a,p[0],p[1]),at(b,p[0],p[1]),at(b,q[0],q[1]),at(a,q[0],q[1]),normal(a,np),normal(b,np),normal(b,nq),normal(a,nq));}
    }
  }
  function paperLabel(out,z,side){
    const data=[];ring(data,.240,.418,z+side*.065,.0026,192);
    for(let i=0;i<data.length;i+=6){const r=Math.hypot(data[i],data[i+1]),a=Math.atan2(data[i+1],data[i]),edge=Math.max(0,(r-.402)/.016);const cut=edge*(Math.sin(a*43.)*.00022+Math.sin(a*107.)*.00012);data[i]*=(r+cut)/r;data[i+1]*=(r+cut)/r;data[i+2]+=side*edge*(.0005*Math.sin(a*6.)+.00016*Math.sin(a*23.));}
    for(const value of data)out.push(value);
  }
  function tube(out,points,radius){
    for(let j=0;j<points.length-1;j++){
      const p=points[j],q=points[j+1],t=norm(q.map((v,i)=>v-p[i]));const a=norm([-t[1],t[0],0]),b=[t[1]*a[2]-t[2]*a[1],t[2]*a[0]-t[0]*a[2],t[0]*a[1]-t[1]*a[0]];
      for(let k=0;k<10;k++){const na=a.map((v,i)=>v*Math.cos(k*Math.PI/5)+b[i]*Math.sin(k*Math.PI/5)),nb=a.map((v,i)=>v*Math.cos((k+1)*Math.PI/5)+b[i]*Math.sin((k+1)*Math.PI/5));quad(out,p.map((v,i)=>v+na[i]*radius),p.map((v,i)=>v+nb[i]*radius),q.map((v,i)=>v+nb[i]*radius),q.map((v,i)=>v+na[i]*radius),na,nb,nb,na);}
    }
  }
  function mesh(data,kind,c,coordinates=null){const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);let detailBuffer=null;if(coordinates){if(coordinates.length!==data.length/3)throw Error('Несогласованные координаты нити');detailBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,detailBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(coordinates),gl.STATIC_DRAW);}return{buffer,detailBuffer,count:data.length/6,kind,color:c};}
  const graphite=[],metal=[],paper=[],recess=[],detail=[],sockets=[];
  ring(graphite,.225,.440,0,.96);
  for(const z of [-.36,-.18,0,.18,.36])ring(graphite,.2208,.229,z,.010,160);
  for(let k=0;k<12;k++)ring(detail,.216,.230,0,.77,6,k*Math.PI/6,.037);
  for(const z of [-.475,.475]){
    const side=Math.sign(z);
    lathe(graphite,[[.872,z-.030],[1.067,z-.045],[1.085,z-.037],[1.097,z-.017],[1.097,z+.017],[1.085,z+.037],[1.067,z+.045],[.872,z+.030]],192);
    ring(graphite,.225,.455,z,.126);ring(graphite,.442,.466,z+side*.026,.019);
    for(let k=0;k<8;k++){
      const a=k*Math.PI/4-.21;roundedSpoke(graphite,.435,.91,z,.076,a,.42);
      slotRim(detail,z,k*Math.PI/4);
      ring(graphite,.49,.881,z-side*.050,.017,20,a+.075,.026);
      const theta=k*Math.PI/4+Math.PI/8;
      ring(graphite,.0133,.0175,z,.089,40,0,Math.PI*2,1.015*Math.cos(theta),1.015*Math.sin(theta));
      ring(graphite,.0132,.022,z+side*.046,.006,48,0,Math.PI*2,1.015*Math.cos(theta),1.015*Math.sin(theta));
      ring(recess,.017,.027,z+side*.064,.005,48,0,Math.PI*2,.438*Math.cos(a+.21),.438*Math.sin(a+.21));
      ring(metal,.002,.017,z+side*.071,.012,64,0,Math.PI*2,.438*Math.cos(a+.21),.438*Math.sin(a+.21));
      const cx=.438*Math.cos(a+.21),cy=.438*Math.sin(a+.21);
      lathe(sockets,[[.00508,z+side*.077],[.00465,z+side*.073],[.00465,z+side*.066],[.0062,z+side*.066],[.0062,z+side*.076]],6,a+.21,Math.PI*2,cx,cy);
      ring(recess,0,.0048,z+side*.066,.001,6,a+.21,Math.PI*2,cx,cy);
    }
    for(let k=0;k<96;k++)lathe(detail,[[1.091,z-.012],[1.098,z-.014],[1.103,z-.008],[1.103,z+.008],[1.098,z+.014],[1.091,z+.012]],3,k*Math.PI/48,.012);
    ring(graphite,1.079,1.092,z+side*.027,.016,192);
    ring(recess,1.054,1.059,z+side*.045,.003,256);
    paperLabel(paper,z,side);
  }
  const staticMeshes=[mesh(graphite,0,[.18,.195,.216]),mesh(metal,2,[.39,.43,.48]),mesh(paper,3,[1,1,1]),mesh(recess,6,[.055,.065,.078]),mesh(detail,7,[.18,.195,.216]),mesh(sockets,8,[.30,.33,.37])];
  const floorData=[];quad(floorData,[-3,-1.19,-3],[3,-1.19,-3],[3,-1.19,3],[-3,-1.19,3],[0,1,0],[0,1,0],[0,1,0],[0,1,0]);const floor=mesh(floorData,5,[0,0,0]);
  let filament=null,winding=null,geometryRevision=0;
  function makeFilament(){
    const data=[],wireData=[],wireCoordinates=[],ri=.445,ro=Math.sqrt(ri*ri+(weight/1000)*(1.014*1.014-ri*ri)),wireRadius=.0087;
    if(weight>0){
      const bodyRadius=Math.max(ri+.0005,ro-.0125);lathe(data,[[ri,-.401],[bodyRadius,-.401],[bodyRadius,.401],[ri,.401]],256);
      const helix=[],turns=44,segments=turns*96;
      for(let i=0;i<=segments;i++){const t=i/segments,a=t*turns*Math.PI*2,profile=.0023*(1/3-(t*2-1)**2),r=Math.max(ri+.004,ro-wireRadius)+profile+.0008*Math.sin(a*3.+t*31.)+.0004*Math.cos(a*7.);const z=-.402+.804*t+.0015*Math.sin(a+t*7.);helix.push([r*Math.cos(a),r*Math.sin(a),z]);}curveTube(wireData,helix,wireRadius,12,wireCoordinates);
      const span=ro-ri-2*wireRadius,spiralTurns=Math.max(0,Math.floor(span/(wireRadius*2.05)));
      if(spiralTurns>0)for(const sign of [-1,1]){
        const spiral=[],count=spiralTurns*128;
        for(let i=0;i<=count;i++){const t=i/count,a=t*spiralTurns*Math.PI*2+sign*.18,r=ri+wireRadius+span*t+.001*Math.sin(a*2.+t*9.),z=sign*(.409+.0009*Math.sin(a*3.+t*23.));spiral.push([r*Math.cos(a),r*Math.sin(a),z]);}curveTube(wireData,spiral,wireRadius,12,wireCoordinates);
      }
      let tailRadius=ro-wireRadius,tailZ=.20;
      if(weight>80){const crossover=[],crossTurns=2.4;for(let i=0;i<=288;i++){const t=i/288,a=-.48-(1-t)*crossTurns*Math.PI*2,lift=Math.min(1,t*12),r=ro-wireRadius+lift*(wireRadius+.0045)+.0008*Math.sin(a*2.);crossover.push([r*Math.cos(a),r*Math.sin(a),.389-.072*t]);}curveTube(wireData,crossover,wireRadius,12,wireCoordinates);tailRadius=ro+.0045;tailZ=.317;}
      const hole=-Math.PI/8,hx=1.015*Math.cos(hole),hy=1.015*Math.sin(hole),p0=[tailRadius*Math.cos(-.48),tailRadius*Math.sin(-.48),tailZ],p1=[ro*Math.cos(-.34),ro*Math.sin(-.34),.42],p2=[hx,hy,.69],p3=[hx,hy,.55];
      const tail=[];for(let j=0;j<=48;j++){const t=j/48,u=1-t;tail.push(p0.map((v,k)=>u*u*u*v+3*u*u*t*p1[k]+3*u*t*t*p2[k]+t*t*t*p3[k]));}for(let j=1;j<=10;j++)tail.push([hx,hy,.55-.13*j/10]);curveTube(wireData,tail,.0075,12,wireCoordinates);
    }
    if(filament)gl.deleteBuffer(filament.buffer);if(winding){gl.deleteBuffer(winding.buffer);if(winding.detailBuffer)gl.deleteBuffer(winding.detailBuffer);}filament=mesh(data,1,[1,1,1]);winding=mesh(wireData,4,[1,1,1],wireCoordinates);geometryRevision++;
    root.dataset.vertices=staticMeshes.reduce((sum,m)=>sum+m.count,0)+filament.count+winding.count;
  }
  makeFilament();
  const labelCanvas=document.createElement('canvas');labelCanvas.width=labelCanvas.height=1024;
  const ctx=labelCanvas.getContext('2d'),texture=gl.createTexture();
  const paperBase=document.createElement('canvas');paperBase.width=paperBase.height=1024;const paperCtx=paperBase.getContext('2d');paperCtx.fillStyle='#eae7dd';paperCtx.fillRect(0,0,1024,1024);let paperSeed=9127;
  const paperRandom=()=>{paperSeed=(Math.imul(paperSeed,1664525)+1013904223)>>>0;return paperSeed/4294967296;};
  for(let i=0;i<6500;i++){paperCtx.fillStyle=i%2?'rgba(72,82,65,.07)':'rgba(255,255,250,.32)';paperCtx.fillRect(paperRandom()*1024,paperRandom()*1024,.45+paperRandom()*2.3,.4+paperRandom()*.7);}
  function arcText(context,text,radius,angle,font,color,reverse=false){
    context.save();context.font=font;context.fillStyle=color;context.textAlign='center';context.textBaseline='middle';const widths=[...text].map(c=>context.measureText(c).width+2),span=widths.reduce((a,b)=>a+b,0)/radius;let a=angle+(reverse?span/2:-span/2);
    [...text].forEach((char,i)=>{const da=widths[i]/radius,pos=a+(reverse?-da/2:da/2);context.save();context.translate(512+radius*Math.cos(pos),512+radius*Math.sin(pos));context.rotate(pos+(reverse?-Math.PI/2:Math.PI/2));context.fillText(char,0,0);context.restore();a+=reverse?-da:da;});context.restore();
  }
  function configureTexture(unit,target,source){gl.activeTexture(unit);gl.bindTexture(gl.TEXTURE_2D,target);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.generateMipmap(gl.TEXTURE_2D);const anisotropy=gl.getExtension('EXT_texture_filter_anisotropic');if(anisotropy)gl.texParameterf(gl.TEXTURE_2D,anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(8,gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));}
  function updateLabel(){
    ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(paperBase,0,0);
    ctx.strokeStyle='#aaafa8';ctx.lineWidth=2;for(const r of [285,477]){ctx.beginPath();ctx.arc(512,512,r,0,Math.PI*2);ctx.stroke();}
    arcText(ctx,selected.type,381,-Math.PI/2,'500 96px system-ui','#29323b');
    arcText(ctx,Number(current.diameterMM).toFixed(2)+' MM  ·  '+formatCapacity(current.capacityGrams),382,Math.PI/2,'500 32px system-ui','#4e5964',true);
    arcText(ctx,serial(selected),379,Math.PI,'500 29px system-ui','#53606b');
    arcText(ctx,selected.finish===1?'SILK':'FILAMENT',379,0,'500 24px system-ui','#53606b');
    if(current.lot)arcText(ctx,current.lot,383,-2.35,'400 17px system-ui','#68716c');
    arcText(ctx,'KLIPPER FARM  ·  MATERIAL LIBRARY',318,-Math.PI/2,'400 13px system-ui','#7b8077');
    arcText(ctx,(current.ordinal?'SPOOL '+String(current.ordinal).padStart(3,'0')+'  ·  ':'')+selected.type,318,Math.PI/2,'400 13px system-ui','#7b8077',true);
    if(current.barcode){
    const leftCodes=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
    const code=current.barcode;
    const bits='101'+[...code.slice(0,4)].map(c=>leftCodes[+c]).join('')+'01010'+[...code.slice(4)].map(c=>[...leftCodes[+c]].map(b=>b==='1'?'0':'1').join('')).join('')+'101';
    ctx.save();const barcodeAngle=.70;ctx.translate(512+385*Math.cos(barcodeAngle),512+385*Math.sin(barcodeAngle));ctx.rotate(barcodeAngle+Math.PI/2);ctx.fillStyle='#3d4848';const bar=1.25;
    [...bits].forEach((b,i)=>{if(b==='1')ctx.fillRect((i-bits.length/2)*bar,-22,bar,31);});ctx.font='400 13px monospace';ctx.textAlign='center';ctx.fillText(code,0,24);ctx.restore();
    }
    ctx.strokeStyle='#bfc3ba';ctx.lineWidth=1;for(let k=0;k<16;k++){const a=k*Math.PI/8;ctx.beginPath();ctx.moveTo(512+292*Math.cos(a),512+292*Math.sin(a));ctx.lineTo(512+301*Math.cos(a),512+301*Math.sin(a));ctx.stroke();}
    ctx.strokeStyle=color;ctx.lineWidth=12;ctx.beginPath();ctx.arc(512,512,460,Math.PI*.90,Math.PI*1.10);ctx.stroke();ctx.beginPath();ctx.arc(512,512,460,-Math.PI*.10,Math.PI*.10);ctx.stroke();
    configureTexture(gl.TEXTURE0,texture,labelCanvas);gl.uniform1i(loc.uLabel,0);
  }
  updateLabel();
  const printCanvas=document.createElement('canvas');printCanvas.width=printCanvas.height=1024;const printCtx=printCanvas.getContext('2d');
  const printTexture=gl.createTexture();
  function updatePrintLabel(){
    printCtx.clearRect(0,0,1024,1024);
  arcText(printCtx,'KLIPPER FARM',452,-Math.PI/2,'500 28px system-ui','#aab2bc');
  arcText(printCtx,'FILAMENT  ·  '+Number(current.diameterMM).toFixed(2)+' MM',453,Math.PI/2,'400 20px system-ui','#aab2bc',true);
  printCtx.strokeStyle='#68727f';printCtx.lineWidth=2;
  for(let k=0;k<64;k++){const a=k*Math.PI/32,major=k%4===0,rad=481;printCtx.beginPath();printCtx.moveTo(512+rad*Math.cos(a),512+rad*Math.sin(a));printCtx.lineTo(512+(rad-(major?15:6))*Math.cos(a),512+(rad-(major?15:6))*Math.sin(a));printCtx.stroke();}
  for(let k=0;k<8;k++){const a=k*Math.PI/4+Math.PI/8;arcText(printCtx,String(k+1).padStart(2,'0'),413,a,'500 15px system-ui','#788390');}
  for(let k=0;k<8;k++){
    const a=k*Math.PI/4,s=1024/2.22;printCtx.save();printCtx.translate(512+.70*s*Math.cos(a),512+.70*s*Math.sin(a));printCtx.rotate(a);printCtx.textAlign='center';printCtx.textBaseline='middle';printCtx.font='500 13px system-ui';printCtx.fillStyle='#7d8995';printCtx.fillText(k%2?'REUSABLE':'KF · SPOOL',0,-.073*s);
    printCtx.fillStyle='#64717d';for(let j=0;j<7;j++)printCtx.fillRect((j-3)*8,.073*s,1.2,j%3===0?8:4);printCtx.restore();
    printCtx.strokeStyle='#56616c';printCtx.lineWidth=1;printCtx.beginPath();printCtx.arc(512+.535*s*Math.cos(a),512+.535*s*Math.sin(a),.017*s,0,Math.PI*2);printCtx.stroke();
  }
configureTexture(gl.TEXTURE1,printTexture,printCanvas);gl.uniform1i(loc.uPrint,1);
  }
  updatePrintLabel();
  function rotation(){const cy=Math.cos(yaw),sy=Math.sin(yaw),cx=Math.cos(pitch),sx=Math.sin(pitch),cz=Math.cos(roll),sz=Math.sin(roll);return new Float32Array([cz*cy-sz*sx*sy,sz*cy+cz*sx*sy,-cx*sy,-sz*cx,cz*cx,sx,cz*sy+sz*sx*cy,sz*sy-cz*sx*cy,cx*cy]);}
  function rgb(hex){return[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255);}
  function render(size){
    if(disposed||contextLost)return;
    const rect=canvas.getBoundingClientRect(),dpr=Math.min(Math.max(window.devicePixelRatio||1,inspector?1.5:1.25),pixelRatioCap),thumbnail=typeof size==='number'&&size>0;const w=thumbnail?size:Math.max(1,Math.round(rect.width*dpr)),h=thumbnail?size:Math.max(1,Math.round(rect.height*dpr));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    const objects=[filament,winding,...staticMeshes],rot=rotation(),useShadow=shadowReady&&!thumbnail&&!booting,usePost=!thumbnail&&!booting&&!interacting&&preparePost(w,h),viewZoom=(thumbnail?1:zoom)*Math.min(1,w/h*1.04);
    if(useShadow){
      const key=[geometryRevision,yaw.toFixed(4),pitch.toFixed(4),roll.toFixed(4)].join('|');
      if(key!==lastShadowKey){
        gl.bindFramebuffer(gl.FRAMEBUFFER,shadowFBO);gl.viewport(0,0,shadowSize,shadowSize);gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.disable(gl.BLEND);gl.depthMask(true);gl.useProgram(shadowProgram);gl.uniformMatrix3fv(shadowLoc.rotation,false,rot);gl.uniformMatrix4fv(shadowLoc.matrix,false,lightMatrix);
        for(const m of objects){if(m.kind===4)continue;gl.bindBuffer(gl.ARRAY_BUFFER,m.buffer);gl.enableVertexAttribArray(shadowLoc.position);gl.vertexAttribPointer(shadowLoc.position,3,gl.FLOAT,false,24,0);gl.uniform1f(shadowLoc.kind,m.kind);gl.drawArrays(gl.TRIANGLES,0,m.count);}lastShadowKey=key;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,usePost?postFBO:null);gl.useProgram(program);gl.viewport(0,0,w,h);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.uniformMatrix3fv(loc.uRotation,false,rot);gl.uniform1f(loc.uAspect,w/h);gl.uniform1f(loc.uZoom,viewZoom);gl.uniform1f(loc.uGloss,gloss);gl.uniform1f(loc.uShadowOn,useShadow?1:0);gl.uniform2f(loc.uViewport,w,h);gl.uniform1f(loc.uWoundRadius,Math.sqrt(.445*.445+(weight/1000)*(1.014*1.014-.445*.445)));gl.uniform1f(loc.uTransmission,selected.type==='PETG'?.32:selected.type==='TPU'?.25:selected.type==='PLA'?.15:.07);
    gl.uniform3fv(loc.uFilamentColor,rgb(color));
    const draw=m=>{gl.bindBuffer(gl.ARRAY_BUFFER,m.buffer);gl.enableVertexAttribArray(loc.aPosition);gl.enableVertexAttribArray(loc.aNormal);gl.vertexAttribPointer(loc.aPosition,3,gl.FLOAT,false,24,0);gl.vertexAttribPointer(loc.aNormal,3,gl.FLOAT,false,24,12);if(m.detailBuffer){gl.bindBuffer(gl.ARRAY_BUFFER,m.detailBuffer);gl.enableVertexAttribArray(loc.aStrand);gl.vertexAttribPointer(loc.aStrand,2,gl.FLOAT,false,8,0);}else{gl.disableVertexAttribArray(loc.aStrand);gl.vertexAttrib2f(loc.aStrand,0,0);}gl.uniform3fv(loc.uColor,m.kind===1||m.kind===4?rgb(color):m.color);gl.uniform1f(loc.uKind,m.kind);gl.drawArrays(gl.TRIANGLES,0,m.count);};
    if(useShadow){gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);draw(floor);gl.depthMask(true);gl.disable(gl.BLEND);}
    for(const m of objects)draw(m);
    if(usePost)finishPost(w,h,viewZoom);root.dataset.postprocessed=String(!!usePost);
    root.dataset.rendered='true';
  }

  function assertLive(){if(disposed)throw new Error('Рендерер уже уничтожен');if(contextLost)throw new Error('Контекст WebGL потерян; создайте рендерер заново');}
  function updateAccessibleName(){canvas.setAttribute('role','img');canvas.setAttribute('aria-label',current.material+', '+current.grams+' г из '+current.capacityGrams+' г');}
  function setSpool(next){
    assertLive();const value=normalizeSpool(next),nextWeight=Math.min(1,value.grams/value.capacityGrams)*1000,geometryChanged=nextWeight!==weight;
    current=value;selected={type:current.material,finish:current.finish};labelOrdinal=current.ordinal||1;color=current.color;weight=nextWeight;gloss=current.finish;
    if(geometryChanged)makeFilament();updateLabel();updatePrintLabel();updateAccessibleName();render();return api;
  }
  function updateSpool(patch){return setSpool({...current,...patch});}
  function setView(next={}){assertLive();for(const [key,value] of Object.entries(next)){if(!['yaw','pitch','roll','zoom'].includes(key)||!Number.isFinite(value))throw new TypeError('Некорректный ракурс: '+key);}
    yaw=next.yaw??yaw;pitch=Math.max(-1.1,Math.min(1.1,next.pitch??pitch));roll=next.roll??roll;zoom=Math.max(.8,Math.min(1.9,next.zoom??zoom));render();return api;}
  function setMode(mode){assertLive();if(mode!=='card'&&mode!=='inspect')throw new TypeError('Режим: card или inspect');inspector=mode==='inspect';render();return api;}
  function captureThumbnail(size=160){assertLive();if(!Number.isInteger(size)||size<32||size>1024)throw new TypeError('Размер изображения: целое 32…1024');render(size);const image=canvas.toDataURL('image/png');render();return image;}
  const down=e=>{if(disposed||contextLost||e.button!==0)return;interacting=true;drag={x:e.clientX,y:e.clientY,yaw,pitch};canvas.setPointerCapture(e.pointerId);};
  const move=e=>{if(!drag||disposed||contextLost)return;yaw=drag.yaw+(e.clientX-drag.x)*.010;pitch=Math.max(-1.1,Math.min(1.1,drag.pitch+(e.clientY-drag.y)*.008));if(!dragFrame)dragFrame=requestAnimationFrame(()=>{dragFrame=0;render();});};
  const up=()=>{if(!drag)return;drag=null;interacting=false;if(dragFrame){cancelAnimationFrame(dragFrame);dragFrame=0;}render();};
  const lost=e=>{e.preventDefault();contextLost=true;drag=null;interacting=false;if(dragFrame){cancelAnimationFrame(dragFrame);dragFrame=0;}canvas.dataset.rendered='false';options.onError?.(new Error('Контекст WebGL потерян; пересоздайте просмотр катушки'));};
  const restored=()=>options.onError?.(new Error('Контекст WebGL восстановлен; требуется новый экземпляр просмотра'));
  canvas.addEventListener('webglcontextlost',lost);canvas.addEventListener('webglcontextrestored',restored);
  if(options.interactive!==false){canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);}
  const resize=()=>render();const observer=typeof ResizeObserver==='function'?new ResizeObserver(resize):null;if(observer)observer.observe(canvas);else window.addEventListener('resize',resize);
  function destroy(){
    if(disposed)return;disposed=true;observer?.disconnect();window.removeEventListener('resize',resize);if(dragFrame)cancelAnimationFrame(dragFrame);
    canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',up);canvas.removeEventListener('webglcontextlost',lost);canvas.removeEventListener('webglcontextrestored',restored);
    for(const m of [...staticMeshes,filament,winding,floor])if(m){gl.deleteBuffer(m.buffer);if(m.detailBuffer)gl.deleteBuffer(m.detailBuffer);}if(postTriangle)gl.deleteBuffer(postTriangle);
    for(const t of [texture,printTexture,shadowTexture,postColor,postDepth])if(t)gl.deleteTexture(t);for(const f of [shadowFBO,postFBO])if(f)gl.deleteFramebuffer(f);gl.deleteRenderbuffer(shadowDepth);
    for(const p of [program,shadowProgram,postProgram])if(p)gl.deleteProgram(p);for(const s of ownedShaders)gl.deleteShader(s);canvas.dataset.rendered='false';
    if(options.releaseContextOnDestroy!==false)gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  const api={setSpool,updateSpool,setView,setMode,resize,captureThumbnail,destroy,getState:()=>({spool:{...current},view:{yaw,pitch,roll,zoom},mode:inspector?'inspect':'card',vertices:Number(root.dataset.vertices)||0,disposed,contextLost})};
  booting=false;updateAccessibleName();render();return api;
}

export {createFilamentSpool};
