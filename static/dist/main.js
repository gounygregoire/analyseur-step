`),n=[];for(let a=0;a<s.length;a++)n.push(a+1+": "+s[a]+`
`);this.errors=[],this.errors.push(""),this.errors.push(e.getShaderInfoLog(this.handle)),this.errors=this.errors.concat(n.join(""))}}destroy(){}}class yg{constructor(e,t){this.bindTexture=function(i,s){return i.bind(s)?(e.uniform1i(t,s),!0):!1}}}class Nw{constructor(e,t){this._gl=e,this.location=t}bindArrayBuffer(e){e&&(e.bind(),this._gl.enableVertexAttribArray(this.location),this._gl.vertexAttribPointer(this.location,e.itemSize,e.itemType,e.normalized,e.stride,e.offset))}}const Pg=new Ao({});function wg(r){const e=[];let t,i;for(let s=0,n=r.length;s<n;s++)t=r[s],i=t.indexOf("/"),i>0&&t.charAt(i+1)==="/"&&(t=t.substring(0,i)),e.push(t);return e.join(`
`)}function Mc(r){console.error(r.join(`
`))}class Ki{constructor(e,t){this.id=Pg.addItem({}),this.source=t,this.init(e)}init(e){if(this.gl=e,this.allocated=!1,this.compiled=!1,this.linked=!1,this.validated=!1,this.errors=null,this.uniforms={},this.samplers={},this.attributes={},this._vertexShader=new vg(e,e.VERTEX_SHADER,wg(this.source.vertex)),this._fragmentShader=new vg(e,e.FRAGMENT_SHADER,wg(this.source.fragment)),!this._vertexShader.allocated){this.errors=["Vertex shader failed to allocate"].concat(this._vertexShader.errors),Mc(this.errors);return}if(!this._fragmentShader.allocated){this.errors=["Fragment shader failed to allocate"].concat(this._fragmentShader.errors),Mc(this.errors);return}if(this.allocated=!0,!this._vertexShader.compiled){this.errors=["Vertex shader failed to compile"].concat(this._vertexShader.errors),Mc(this.errors);return}if(!this._fragmentShader.compiled){this.errors=["Fragment shader failed to compile"].concat(this._fragmentShader.errors),Mc(this.errors);return}this.compiled=!0;let t,i,s,n,a;if(this.handle=e.createProgram(),!this.handle){this.errors=["Failed to allocate program"];return}if(e.attachShader(this.handle,this._vertexShader.handle),e.attachShader(this.handle,this._fragmentShader.handle),e.linkProgram(this.handle),this.linked=e.getProgramParameter(this.handle,e.LINK_STATUS),this.validated=!0,!this.linked||!this.validated){this.errors=[],this.errors.push(""),this.errors.push(e.getProgramInfoLog(this.handle)),this.errors.push(`
Vertex shader:
`),this.errors=this.errors.concat(this.source.vertex),this.errors.push(`
Fragment shader:
 * @author https://github.com/tmarti, with support from https://tribia.com/
 * @license MIT
 *
 * This file takes a geometry given by { positionsCompressed, indices }, and returns
 * equivalent { positionsCompressed, indices } arrays but which only contain unique
 * positionsCompressed.
 *
 * The time is O(N logN) with the number of positionsCompressed due to a pre-sorting
 * step, but is much more GC-friendly and actually faster than the classic O(N)
 * approach based in keeping a hash-based LUT to identify unique positionsCompressed.
 * @author https://github.com/tmarti, with support from https://tribia.com/
 * @license MIT
            supported values are LinearFilter, LinearMipMapNearestFilter, NearestMipMapNearestFilter, 
                    precision highp float;
                    precision highp int;
                    
                    in vec3 aPosition;
                    in vec2 aUV;            
                    
                    out vec2 vUV;
                    
                    void main () {
                        gl_Position = vec4(aPosition, 1.0);
                        vUV = aUV;
                    }`],fragment:[`#version 300 es      
                precision highp float;
                precision highp int;           
                
                #define NORMAL_TEXTURE 0
                #define PI 3.14159265359
                #define PI2 6.28318530718
                #define EPSILON 1e-6
                #define NUM_SAMPLES ${this._numSamples}
                #define NUM_RINGS 4              
            
                in vec2        vUV;
            
                uniform sampler2D   uDepthTexture;
               
                uniform float       uCameraNear;
                uniform float       uCameraFar;
                uniform mat4        uProjectMatrix;
                uniform mat4        uInverseProjectMatrix;
                
                uniform bool        uPerspective;

                uniform float       uScale;
                uniform float       uIntensity;
                uniform float       uBias;
                uniform float       uKernelRadius;
                uniform float       uMinResolution;
                uniform vec2        uViewport;
                uniform float       uRandomSeed;

                float pow2( const in float x ) { return x*x; }
                
                highp float rand( const in vec2 uv ) {
                    const highp float a = 12.9898, b = 78.233, c = 43758.5453;
                    highp float dt = dot( uv.xy, vec2( a,b ) ), sn = mod( dt, PI );
                    return fract(sin(sn) * c);
                }

                vec3 packNormalToRGB( const in vec3 normal ) {
                    return normalize( normal ) * 0.5 + 0.5;
                }

                vec3 unpackRGBToNormal( const in vec3 rgb ) {
                    return 2.0 * rgb.xyz - 1.0;
                }

                const float packUpscale = 256. / 255.;
                const float unpackDownScale = 255. / 256.; 

                const vec3 packFactors = vec3( 256. * 256. * 256., 256. * 256.,  256. );
                const vec4 unPackFactors = unpackDownScale / vec4( packFactors, 1. );   

                const float shiftRights = 1. / 256.;

                vec4 packFloatToRGBA( const in float v ) {
                    vec4 r = vec4( fract( v * packFactors ), v );
                    r.yzw -= r.xyz * shiftRights; 
                    return r * packUpscale;
                }

                float unpackRGBAToFloat( const in vec4 v ) {                   
                    return dot( floor( v * 255.0 + 0.5 ) / 255.0, unPackFactors );
                }
                
                float perspectiveDepthToViewZ( const in float invClipZ, const in float near, const in float far ) {
                    return ( near * far ) / ( ( far - near ) * invClipZ - far );
                }

                float orthographicDepthToViewZ( const in float linearClipZ, const in float near, const in float far ) {
                    return linearClipZ * ( near - far ) - near;
                }
                
                float getDepth( const in vec2 screenPosition ) {
                    return vec4(texture(uDepthTexture, screenPosition)).r;
                }

                float getViewZ( const in float depth ) {
                     if (uPerspective) {
                         return perspectiveDepthToViewZ( depth, uCameraNear, uCameraFar );
                     } else {
                        return orthographicDepthToViewZ( depth, uCameraNear, uCameraFar );
                     }
                }

                vec3 getViewPos( const in vec2 screenPos, const in float depth, const in float viewZ ) {
                	float clipW = uProjectMatrix[2][3] * viewZ + uProjectMatrix[3][3];
                	vec4 clipPosition = vec4( ( vec3( screenPos, depth ) - 0.5 ) * 2.0, 1.0 );
                	clipPosition *= clipW; 
                	return ( uInverseProjectMatrix * clipPosition ).xyz;
                }

                vec3 getViewNormal( const in vec3 viewPosition, const in vec2 screenPos ) {               
                    return normalize( cross( dFdx( viewPosition ), dFdy( viewPosition ) ) );
                }

                float scaleDividedByCameraFar;
                float minResolutionMultipliedByCameraFar;

                float getOcclusion( const in vec3 centerViewPosition, const in vec3 centerViewNormal, const in vec3 sampleViewPosition ) {
                	vec3 viewDelta = sampleViewPosition - centerViewPosition;
                	float viewDistance = length( viewDelta );
                	float scaledScreenDistance = scaleDividedByCameraFar * viewDistance;
                	return max(0.0, (dot(centerViewNormal, viewDelta) - minResolutionMultipliedByCameraFar) / scaledScreenDistance - uBias) / (1.0 + pow2( scaledScreenDistance ) );
                }

                const float ANGLE_STEP = PI2 * float( NUM_RINGS ) / float( NUM_SAMPLES );
                const float INV_NUM_SAMPLES = 1.0 / float( NUM_SAMPLES );

                float getAmbientOcclusion( const in vec3 centerViewPosition ) {
            
                	scaleDividedByCameraFar = uScale / uCameraFar;
                	minResolutionMultipliedByCameraFar = uMinResolution * uCameraFar;
                	vec3 centerViewNormal = getViewNormal( centerViewPosition, vUV );

                	float angle = rand( vUV + uRandomSeed ) * PI2;
                	vec2 radius = vec2( uKernelRadius * INV_NUM_SAMPLES ) / uViewport;
                	vec2 radiusStep = radius;

                	float occlusionSum = 0.0;
                	float weightSum = 0.0;

                	for( int i = 0; i < NUM_SAMPLES; i ++ ) {
                		vec2 sampleUv = vUV + vec2( cos( angle ), sin( angle ) ) * radius;
                		radius += radiusStep;
                		angle += ANGLE_STEP;

                		float sampleDepth = getDepth( sampleUv );
                		if( sampleDepth >= ( 1.0 - EPSILON ) ) {
                			continue;
                		}

                		float sampleViewZ = getViewZ( sampleDepth );
                		vec3 sampleViewPosition = getViewPos( sampleUv, sampleDepth, sampleViewZ );
                		occlusionSum += getOcclusion( centerViewPosition, centerViewNormal, sampleViewPosition );
                		weightSum += 1.0;
                	}

                	if( weightSum == 0.0 ) discard;

                	return occlusionSum * ( uIntensity / weightSum );
                }

                out vec4 outColor;
   
                void main() {
                
                	float centerDepth = getDepth( vUV );
                	
                	if( centerDepth >= ( 1.0 - EPSILON ) ) {
                		discard;
                	}

                	float centerViewZ = getViewZ( centerDepth );
                	vec3 viewPosition = getViewPos( vUV, centerDepth, centerViewZ );

                	float ambientOcclusion = getAmbientOcclusion( viewPosition );
                
                	outColor = packFloatToRGBA(  1.0- ambientOcclusion );
                }`]}),this._program.errors){console.error(this._program.errors.join(`
`)),this._programError=!0;return}const s=new Float32Array([1,1,0,1,0,0,1,0]),n=new Float32Array([1,1,0,-1,1,0,-1,-1,0,1,-1,0]),a=new Uint32Array([0,1,2,0,2,3]);this._positionsBuf=new Lt(i,i.ARRAY_BUFFER,n,n.length,3,i.STATIC_DRAW),this._uvBuf=new Lt(i,i.ARRAY_BUFFER,s,s.length,2,i.STATIC_DRAW),this._indicesBuf=new Lt(i,i.ELEMENT_ARRAY_BUFFER,a,a.length,1,i.STATIC_DRAW),this._program.bind(),this._uCameraNear=this._program.getLocation("uCameraNear"),this._uCameraFar=this._program.getLocation("uCameraFar"),this._uCameraProjectionMatrix=this._program.getLocation("uProjectMatrix"),this._uCameraInverseProjectionMatrix=this._program.getLocation("uInverseProjectMatrix"),this._uPerspective=this._program.getLocation("uPerspective"),this._uScale=this._program.getLocation("uScale"),this._uIntensity=this._program.getLocation("uIntensity"),this._uBias=this._program.getLocation("uBias"),this._uKernelRadius=this._program.getLocation("uKernelRadius"),this._uMinResolution=this._program.getLocation("uMinResolution"),this._uViewport=this._program.getLocation("uViewport"),this._uRandomSeed=this._program.getLocation("uRandomSeed"),this._aPosition=this._program.getAttribute("aPosition"),this._aUV=this._program.getAttribute("aUV"),this._dirty=!1}destroy(){this._program&&(this._program.destroy(),this._program=null)}}const HE=4,jE=.01,Ou=16,zE=new Float32Array(V1(Ou+1,[0,1])),GE=new Float32Array(V1(Ou+1,[1,0])),WE=new Float32Array(XE(Ou+1,HE)),np=new Float32Array(2);class KE{constructor(e){this._scene=e,this._program=null,this._programError=!1,this._aPosition=null,this._aUV=null,this._uDepthTexture="uDepthTexture",this._uOcclusionTexture="uOcclusionTexture",this._uViewport=null,this._uCameraNear=null,this._uCameraFar=null,this._uCameraProjectionMatrix=null,this._uCameraInverseProjectionMatrix=null,this._uvBuf=null,this._positionsBuf=null,this._indicesBuf=null,this.init()}init(){const e=this._scene.canvas.gl;if(this._program=new Ki(e,{vertex:[`#version 300 es
                precision highp float;
                precision highp int;
                    
                in vec3 aPosition;
                in vec2 aUV;
                uniform vec2 uViewport;
                out vec2 vUV;
                out vec2 vInvSize;
                void main () {
                    vUV = aUV;
                    vInvSize = 1.0 / uViewport;
                    gl_Position = vec4(aPosition, 1.0);
                }`],fragment:[`#version 300 es
                precision highp float;
                precision highp int;
                    
                #define PI 3.14159265359
                #define PI2 6.28318530718
                #define EPSILON 1e-6

                #define KERNEL_RADIUS ${Ou}

                in vec2        vUV;
                in vec2        vInvSize;
            
                uniform sampler2D   uDepthTexture;
                uniform sampler2D   uOcclusionTexture;              
               
                uniform float       uCameraNear;
                uniform float       uCameraFar;               
                uniform float       uDepthCutoff;

                uniform vec2        uSampleOffsets[ KERNEL_RADIUS + 1 ];
                uniform float       uSampleWeights[ KERNEL_RADIUS + 1 ];

                const float         unpackDownscale = 255. / 256.; 

                const vec3          packFactors = vec3( 256. * 256. * 256., 256. * 256.,  256. );
                const vec4          unpackFactors = unpackDownscale / vec4( packFactors, 1. );   

                const float packUpscale = 256. / 255.;
       
                const float shiftRights = 1. / 256.;
                
                float unpackRGBAToFloat( const in vec4 v ) {
                    return dot( floor( v * 255.0 + 0.5 ) / 255.0, unpackFactors );
                }               

                vec4 packFloatToRGBA( const in float v ) {
                    vec4 r = vec4( fract( v * packFactors ), v );
                    r.yzw -= r.xyz * shiftRights; 
                    return r * packUpscale;
                }

                float viewZToOrthographicDepth( const in float viewZ) {
                    return ( viewZ + uCameraNear ) / ( uCameraNear - uCameraFar );
                }
              
                float orthographicDepthToViewZ( const in float linearClipZ) {
                    return linearClipZ * ( uCameraNear - uCameraFar ) - uCameraNear;
                }

                float viewZToPerspectiveDepth( const in float viewZ) {
                    return (( uCameraNear + viewZ ) * uCameraFar ) / (( uCameraFar - uCameraNear ) * viewZ );
                }
                
                float perspectiveDepthToViewZ( const in float invClipZ) {
                    return ( uCameraNear * uCameraFar ) / ( ( uCameraFar - uCameraNear ) * invClipZ - uCameraFar );
                }

                float getDepth( const in vec2 screenPosition ) {
                    return vec4(texture(uDepthTexture, screenPosition)).r;
                }

                float getViewZ( const in float depth ) {
                     return perspectiveDepthToViewZ( depth );
                }

                out vec4 outColor;
        
                void main() {
                
                    float depth = getDepth( vUV );
                    if( depth >= ( 1.0 - EPSILON ) ) {
                        discard;
                    }

                    float centerViewZ = -getViewZ( depth );
                    bool rBreak = false;
                    bool lBreak = false;

                    float weightSum = uSampleWeights[0];
                    float occlusionSum = unpackRGBAToFloat(texture( uOcclusionTexture, vUV )) * weightSum;

                    for( int i = 1; i <= KERNEL_RADIUS; i ++ ) {

                        float sampleWeight = uSampleWeights[i];
                        vec2 sampleUVOffset = uSampleOffsets[i] * vInvSize;

                        vec2 sampleUV = vUV + sampleUVOffset;
                        float viewZ = -getViewZ( getDepth( sampleUV ) );

                        if( abs( viewZ - centerViewZ ) > uDepthCutoff ) {
                            rBreak = true;
                        }

                        if( ! rBreak ) {
                            occlusionSum += unpackRGBAToFloat(texture( uOcclusionTexture, sampleUV )) * sampleWeight;
                            weightSum += sampleWeight;
                        }

                        sampleUV = vUV - sampleUVOffset;
                        viewZ = -getViewZ( getDepth( sampleUV ) );

                        if( abs( viewZ - centerViewZ ) > uDepthCutoff ) {
                            lBreak = true;
                        }

                        if( ! lBreak ) {
                            occlusionSum += unpackRGBAToFloat(texture( uOcclusionTexture, sampleUV )) * sampleWeight;
                            weightSum += sampleWeight;
                        }
                    }

                    outColor = packFloatToRGBA(occlusionSum / weightSum);
                }`]}),this._program.errors){console.error(this._program.errors.join(`
 * html2canvas 1.4.1 <https://html2canvas.hertzen.com>
 * Copyright (c) 2022 Niklas von Hertzen <https://hertzen.com>
 * Released under MIT License
 *//*! *****************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
    content: "" !important;
    display: none !important;
}`,Z5=function(r){J5(r,"."+Sf+Y5+iv+`
`;ee&&(pt+=`var destructors = [];
`);for(var Mt=ee?"destructors":"null",Ot=["humanName","throwBindingError","invoker","fn","runDestructors","retType","classParam"],Ze=0;Ze<pe;++Ze)pt+=`var arg${Ze}Wired = argType${Ze}['toWireType'](${Mt}, arg${Ze});
`;var ti=R?"rv":"";if(Ot.push("Asyncify"),pt+=`function onDone(${ti}) {
`,ee)pt+=`runDestructors(destructors);
`;else for(var Ze=2;Ze<w.length;++Ze){var xt=Ze===1?"thisWired":"arg"+(Ze-2)+"Wired";w[Ze].destructorFunction!==null&&(pt+=`${xt}_dtor(${xt});
`,Ot.push(`${xt}_dtor`))}return R&&(pt+=`var ret = retType['fromWireType'](rv);
return ret;
`),pt+=`}
`,pt+=`return Asyncify.currData ? Asyncify.whenDone().then(onDone) : onDone(${ti});
`,pt+=`}
`,ee.isVoid||(Ze.push("emval_returnValue"),pt.push(bn),pe+=`  return emval_returnValue(retType, destructorsRef, rv);
`),pe+=`};
            <div class="insight-tooltip">
                <h6 class="mb-2">${s.title}</h6>
                <p class="mb-2 small">${s.description}</p>
        `;return s.causes&&(n+=`
                <div class="mb-2">
                    <strong class="small">Causes fréquentes:</strong>
                    <ul class="small mb-0">
                        ${s.causes.map(a=>`<li>${a}</li>`).join("")}
                    </ul>
                </div>
            `),s.solutions&&(n+=`
                <div class="mb-2">
                    <strong class="small">Solutions recommandées:</strong>
                    <ul class="small mb-0">
                        ${s.solutions.map(a=>`<li>${a}</li>`).join("")}
                    </ul>
                </div>
            `),s.recommendations&&(n+=`
                <div class="mb-2">
                    <strong class="small">Recommandations:</strong>
                    <ul class="small mb-0">
                        ${s.recommendations.map(a=>`<li>${a}</li>`).join("")}
                    </ul>
                </div>
            `),s.impact&&(n+=`
                <div class="alert alert-warning alert-sm mb-0">
                    <small><strong>Impact:</strong> ${s.impact}</small>
                </div>
            `),n+="</div>",n}addInsightIcon(e,t,i,s={}){if(!this.getInsight(t,i))return;const a=this.createInsightTooltip(t,i,s),o=document.createElement("i");o.className="bi bi-info-circle-fill text-info ms-1 insight-icon",o.style.cursor="help",o.setAttribute("data-bs-toggle","tooltip"),o.setAttribute("data-bs-placement","top"),o.setAttribute("data-bs-html","true"),o.setAttribute("data-bs-title",a),e.appendChild(o),typeof bootstrap<"u"&&new bootstrap.Tooltip(o)}createExpandedInsightCard(e,t,i={}){const s=this.getInsight(e,t);if(!s)return null;const n=document.createElement("div");n.className="card border-info mb-3";let a=`
            <div class="card-header bg-info bg-opacity-10">
                <h6 class="mb-0">
                    <i class="bi bi-lightbulb me-2"></i>${s.title}
                </h6>
            </div>
            <div class="card-body">
                <p class="card-text">${s.description}</p>
        `;return s.causes&&(a+=`
                <div class="mb-3">
                    <h6 class="text-warning">Causes fréquentes</h6>
                    <ul class="small">
                        ${s.causes.map(o=>`<li>${o}</li>`).join("")}
                    </ul>
                </div>
            `),s.solutions&&(a+=`
                <div class="mb-3">
                    <h6 class="text-success">Solutions recommandées</h6>
                    <ul class="small">
                        ${s.solutions.map(o=>`<li>${o}</li>`).join("")}
                    </ul>
                </div>
            `),s.recommendations&&(a+=`
                <div class="mb-3">
                    <h6 class="text-primary">Recommandations</h6>
                    <ul class="small">
                        ${s.recommendations.map(o=>`<li>${o}</li>`).join("")}
                    </ul>
                </div>
            `),s.impact&&(a+=`
                <div class="alert alert-warning">
                    <h6 class="alert-heading">Impact sur la production</h6>
                    <p class="mb-0">${s.impact}</p>
                </div>
 * A class to parse color values
 * @author Stoyan Stefanov <sstoo@gmail.com>
 * {@link   http://www.phpied.com/rgb-color-parser-in-javascript/}
 * @license Use it if you like it
 */function p2(r){var e;r=r||"",this.ok=!1,r.charAt(0)=="#"&&(r=r.substr(1,6)),r={aliceblue:"f0f8ff",antiquewhite:"faebd7",aqua:"00ffff",aquamarine:"7fffd4",azure:"f0ffff",beige:"f5f5dc",bisque:"ffe4c4",black:"000000",blanchedalmond:"ffebcd",blue:"0000ff",blueviolet:"8a2be2",brown:"a52a2a",burlywood:"deb887",cadetblue:"5f9ea0",chartreuse:"7fff00",chocolate:"d2691e",coral:"ff7f50",cornflowerblue:"6495ed",cornsilk:"fff8dc",crimson:"dc143c",cyan:"00ffff",darkblue:"00008b",darkcyan:"008b8b",darkgoldenrod:"b8860b",darkgray:"a9a9a9",darkgreen:"006400",darkkhaki:"bdb76b",darkmagenta:"8b008b",darkolivegreen:"556b2f",darkorange:"ff8c00",darkorchid:"9932cc",darkred:"8b0000",darksalmon:"e9967a",darkseagreen:"8fbc8f",darkslateblue:"483d8b",darkslategray:"2f4f4f",darkturquoise:"00ced1",darkviolet:"9400d3",deeppink:"ff1493",deepskyblue:"00bfff",dimgray:"696969",dodgerblue:"1e90ff",feldspar:"d19275",firebrick:"b22222",floralwhite:"fffaf0",forestgreen:"228b22",fuchsia:"ff00ff",gainsboro:"dcdcdc",ghostwhite:"f8f8ff",gold:"ffd700",goldenrod:"daa520",gray:"808080",green:"008000",greenyellow:"adff2f",honeydew:"f0fff0",hotpink:"ff69b4",indianred:"cd5c5c",indigo:"4b0082",ivory:"fffff0",khaki:"f0e68c",lavender:"e6e6fa",lavenderblush:"fff0f5",lawngreen:"7cfc00",lemonchiffon:"fffacd",lightblue:"add8e6",lightcoral:"f08080",lightcyan:"e0ffff",lightgoldenrodyellow:"fafad2",lightgrey:"d3d3d3",lightgreen:"90ee90",lightpink:"ffb6c1",lightsalmon:"ffa07a",lightseagreen:"20b2aa",lightskyblue:"87cefa",lightslateblue:"8470ff",lightslategray:"778899",lightsteelblue:"b0c4de",lightyellow:"ffffe0",lime:"00ff00",limegreen:"32cd32",linen:"faf0e6",magenta:"ff00ff",maroon:"800000",mediumaquamarine:"66cdaa",mediumblue:"0000cd",mediumorchid:"ba55d3",mediumpurple:"9370d8",mediumseagreen:"3cb371",mediumslateblue:"7b68ee",mediumspringgreen:"00fa9a",mediumturquoise:"48d1cc",mediumvioletred:"c71585",midnightblue:"191970",mintcream:"f5fffa",mistyrose:"ffe4e1",moccasin:"ffe4b5",navajowhite:"ffdead",navy:"000080",oldlace:"fdf5e6",olive:"808000",olivedrab:"6b8e23",orange:"ffa500",orangered:"ff4500",orchid:"da70d6",palegoldenrod:"eee8aa",palegreen:"98fb98",paleturquoise:"afeeee",palevioletred:"d87093",papayawhip:"ffefd5",peachpuff:"ffdab9",peru:"cd853f",pink:"ffc0cb",plum:"dda0dd",powderblue:"b0e0e6",purple:"800080",red:"ff0000",rosybrown:"bc8f8f",royalblue:"4169e1",saddlebrown:"8b4513",salmon:"fa8072",sandybrown:"f4a460",seagreen:"2e8b57",seashell:"fff5ee",sienna:"a0522d",silver:"c0c0c0",skyblue:"87ceeb",slateblue:"6a5acd",slategray:"708090",snow:"fffafa",springgreen:"00ff7f",steelblue:"4682b4",tan:"d2b48c",teal:"008080",thistle:"d8bfd8",tomato:"ff6347",turquoise:"40e0d0",violet:"ee82ee",violetred:"d02090",wheat:"f5deb3",white:"ffffff",whitesmoke:"f5f5f5",yellow:"ffff00",yellowgreen:"9acd32"}[r=(r=r.replace(/ /g,"")).toLowerCase()]||r;for(var t=[{re:/^rgb\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\)$/,example:["rgb(123, 234, 45)","rgb(255,234,245)"],process:function(o){return[parseInt(o[1]),parseInt(o[2]),parseInt(o[3])]}},{re:/^(\w{2})(\w{2})(\w{2})$/,example:["#00ff00","336699"],process:function(o){return[parseInt(o[1],16),parseInt(o[2],16),parseInt(o[3],16)]}},{re:/^(\w{1})(\w{1})(\w{1})$/,example:["#fb0","f0f"],process:function(o){return[parseInt(o[1]+o[1],16),parseInt(o[2]+o[2],16),parseInt(o[3]+o[3],16)]}}],i=0;i<t.length;i++){var s=t[i].re,n=t[i].process,a=s.exec(r);a&&(e=n(a),this.r=e[0],this.g=e[1],this.b=e[2],this.ok=!0)}this.r=this.r<0||isNaN(this.r)?0:this.r>255?255:this.r,this.g=this.g<0||isNaN(this.g)?0:this.g>255?255:this.g,this.b=this.b<0||isNaN(this.b)?0:this.b>255?255:this.b,this.toRGB=function(){return"rgb("+this.r+", "+this.g+", "+this.b+")"},this.toHex=function(){var o=this.r.toString(16),l=this.g.toString(16),c=this.b.toString(16);return o.length==1&&(o="0"+o),l.length==1&&(l="0"+l),c.length==1&&(c="0"+c),"#"+o+l+c}}/**
 * @license
 * Joseph Myers does not specify a particular license for his work.
 *
 * Author: Joseph Myers
 * Accessed from: http://www.myersdaily.org/joseph/javascript/md5.js
 *
 * Modified by: Owen Leong
 * @license
 * FPDF is released under a permissive license: there is no usage restriction.
 * You may embed it freely in your application (commercial or not), with or
 * without modifications.
 *
 * Reference: http://www.fpdf.org/en/script/script37.php
 * @license
 * Licensed under the MIT License.
 * http://opensource.org/licenses/mit-license
 * Author: Owen Leong (@owenl131)
 * Date: 15 Oct 2020
 * References:
 * https://www.cs.cmu.edu/~dst/Adobe/Gallery/anon21jul01-pdf-encryption.txt
 * https://github.com/foliojs/pdfkit/blob/master/lib/security.js
 * http://www.fpdf.org/en/script/script37.php
`);return y===B.ADVANCED&&(he+=`
`,this.setCharSpace(this.getCharSpace()||0)),(at=V.horizontalScale)!==void 0&&(qt+=D(100*at)+` Tz
`),V.lang;var Js=-1,_c=V.renderingMode!==void 0?V.renderingMode:V.stroke,Eo=Ht.internal.getCurrentPageInfo().pageContext;switch(_c){case 0:case!1:case"fill":Js=0;break;case 1:case!0:case"stroke":Js=1;break;case 2:case"fillThenStroke":Js=2;break;case 3:case"invisible":Js=3;break;case 4:case"fillAndAddForClipping":Js=4;break;case 5:case"strokeAndAddPathForClipping":Js=5;break;case 6:case"fillThenStrokeAndAddToPathForClipping":Js=6;break;case 7:case"addToPathForClipping":Js=7}var fl=Eo.usedRenderingMode!==void 0?Eo.usedRenderingMode:-1;Js!==-1?qt+=Js+` Tr
`:fl!==-1&&(qt+=`0 Tr
`):Bs=D(Ui)+" "+D(ki)+` Td
`,Bs},an=0;an<oe.length;an++){switch(ra="",ja){case ml:mr=(Wt?"<":"(")+oe[an][0]+(Wt?">":")"),er=parseFloat(oe[an][1]),Ls=parseFloat(oe[an][2]);break;case Qi:mr=(Wt?"<":"(")+oe[an]+(Wt?">":")"),er=Er(m),Ls=zs(k)}ee!==void 0&&ee[an]!==void 0&&(ra=ee[an]+` Tw
`;var ln=`BT
/`;return ln+=ye+" "+Ne+` Tf
`,ln+=D(Ne*_t)+` TL
`,ln+=xn+`
`),n}},Kf=function(r,e){var t=r.fontSize===0?r.maxFontSize:r.fontSize,i={text:"",fontSize:""},s=(e=(e=e.substr(0,1)=="("?e.substr(1):e).substr(e.length-1)==")"?e.substr(0,e.length-1):e).split(" ");s=r.multiline?s.map(function(T){return T.split(`
`,e+="% Width of Text: "+iu(e,r,n=12).width+", FieldWidth:"+o+`
`,e+="("+pl(L)+`) Tj
`,e+=-ai(c)+` 0 Td
`)}},set:function(t){Mi(t)==="object"&&(e=t)}}),Object.defineProperty(this,"caption",{enumerable:!0,configurable:!0,get:function(){return e.CA||""},set:function(t){typeof t=="string"&&(e.CA=t)}}),Object.defineProperty(this,"AS",{enumerable:!1,configurable:!1,get:function(){return r},set:function(t){r=t}}),Object.defineProperty(this,"appearanceState",{enumerable:!0,configurable:!0,get:function(){return r.substr(1,r.length-1)},set:function(t){r="/"+t}})};Rr(Vs,Rn);var mu=function(){Vs.call(this),this.pushButton=!0};Rr(mu,Vs);var dc=function(){Vs.call(this),this.radio=!0,this.pushButton=!1;var r=[];Object.defineProperty(this,"Kids",{enumerable:!0,configurable:!1,get:function(){return r},set:function(e){r=e!==void 0?e:[]}})};Rr(dc,Vs);var ku=function(){var r,e;Rn.call(this),Object.defineProperty(this,"Parent",{enumerable:!1,configurable:!1,get:function(){return r},set:function(s){r=s}}),Object.defineProperty(this,"optionName",{enumerable:!1,configurable:!0,get:function(){return e},set:function(s){e=s}});var t,i={};Object.defineProperty(this,"MK",{enumerable:!1,configurable:!1,get:function(){var s=function(o){return o};this.scope&&(s=this.scope.internal.getEncryptor(this.objId));var n,a=[];for(n in a.push("<<"),i)a.push("/"+n+" ("+pl(s(i[n]))+")");return a.push(">>"),a.join(`
`)},set:function(s){Mi(s)==="object"&&(i=s)}}),Object.defineProperty(this,"caption",{enumerable:!0,configurable:!0,get:function(){return i.CA||""},set:function(s){typeof s=="string"&&(i.CA=s)}}),Object.defineProperty(this,"AS",{enumerable:!1,configurable:!1,get:function(){return t},set:function(s){t=s}}),Object.defineProperty(this,"appearanceState",{enumerable:!0,configurable:!0,get:function(){return t.substr(1,t.length-1)},set:function(s){t="/"+s}}),this.caption="l",this.appearanceState="Off",this._AppearanceType=Vt.RadioButton.Circle,this.appearanceStreamContent=this._AppearanceType.createAppearanceStream(this.optionName)};Rr(ku,Rn),dc.prototype.setAppearance=function(r){if(!("createAppearanceStream"in r)||!("getCA"in r))throw new Error("Couldn't assign Appearance to RadioButton. Appearance was Invalid!");for(var e in this.Kids)if(this.Kids.hasOwnProperty(e)){var t=this.Kids[e];t.appearanceStreamContent=r.createAppearanceStream(t.optionName),t.caption=r.getCA()}},dc.prototype.createOption=function(r){var e=new ku;return e.Parent=this,e.optionName=r,this.Kids.push(e),jD.call(this.scope,e),e};var gu=function(){Vs.call(this),this.fontName="zapfdingbats",this.caption="3",this.appearanceState="On",this.value="On",this.textAlign="center",this.appearanceStreamContent=Vt.CheckBox.createAppearanceStream()};Rr(gu,Vs);var Al=function(){Rn.call(this),this.FT="/Tx",Object.defineProperty(this,"multiline",{enumerable:!0,configurable:!0,get:function(){return!!cs(this.Ff,13)},set:function(e){e?this.Ff=As(this.Ff,13):this.Ff=hs(this.Ff,13)}}),Object.defineProperty(this,"fileSelect",{enumerable:!0,configurable:!0,get:function(){return!!cs(this.Ff,21)},set:function(e){e?this.Ff=As(this.Ff,21):this.Ff=hs(this.Ff,21)}}),Object.defineProperty(this,"doNotSpellCheck",{enumerable:!0,configurable:!0,get:function(){return!!cs(this.Ff,23)},set:function(e){e?this.Ff=As(this.Ff,23):this.Ff=hs(this.Ff,23)}}),Object.defineProperty(this,"doNotScroll",{enumerable:!0,configurable:!0,get:function(){return!!cs(this.Ff,24)},set:function(e){e?this.Ff=As(this.Ff,24):this.Ff=hs(this.Ff,24)}}),Object.defineProperty(this,"comb",{enumerable:!0,configurable:!0,get:function(){return!!cs(this.Ff,25)},set:function(e){e?this.Ff=As(this.Ff,25):this.Ff=hs(this.Ff,25)}}),Object.defineProperty(this,"richText",{enumerable:!0,configurable:!0,get:function(){return!!cs(this.Ff,26)},set:function(e){e?this.Ff=As(this.Ff,26):this.Ff=hs(this.Ff,26)}});var r=null;Object.defineProperty(this,"MaxLen",{enumerable:!0,configurable:!1,get:function(){return r},set:function(e){r=e}}),Object.defineProperty(this,"maxLength",{enumerable:!0,configurable:!0,get:function(){return r},set:function(e){Number.isInteger(e)&&(r=e)}}),Object.defineProperty(this,"hasAppearanceStream",{enumerable:!0,configurable:!0,get:function(){return this.V||this.DV}})};Rr(Al,Rn);var _u=function(){Al.call(this),Object.defineProperty(this,"password",{enumerable:!0,configurable:!0,get:function(){return!!cs(this.Ff,14)},set:function(r){r?this.Ff=As(this.Ff,14):this.Ff=hs(this.Ff,14)}}),this.password=!0};Rr(_u,Al);var Vt={CheckBox:{createAppearanceStream:function(){return{N:{On:Vt.CheckBox.YesNormal},D:{On:Vt.CheckBox.YesPushDown,Off:Vt.CheckBox.OffPushDown}}},YesPushDown:function(r){var e=ro(r);e.scope=r.scope;var t=[],i=r.scope.internal.getFont(r.fontName,r.fontStyle).id,s=r.scope.__private__.encodeColorString(r.color),n=Kf(r,r.caption);return t.push("0.749023 g"),t.push("0 0 "+ai(Vt.internal.getWidth(r))+" "+ai(Vt.internal.getHeight(r))+" re"),t.push("f"),t.push("BMC"),t.push("q"),t.push("0 0 1 rg"),t.push("/"+i+" "+ai(n.fontSize)+" Tf "+s),t.push("BT"),t.push(n.text),t.push("ET"),t.push("Q"),t.push("EMC"),e.stream=t.join(`
`),e},YesNormal:function(r){var e=ro(r);e.scope=r.scope;var t=r.scope.internal.getFont(r.fontName,r.fontStyle).id,i=r.scope.__private__.encodeColorString(r.color),s=[],n=Vt.internal.getHeight(r),a=Vt.internal.getWidth(r),o=Kf(r,r.caption);return s.push("1 g"),s.push("0 0 "+ai(a)+" "+ai(n)+" re"),s.push("f"),s.push("q"),s.push("0 0 1 rg"),s.push("0 0 "+ai(a-1)+" "+ai(n-1)+" re"),s.push("W"),s.push("n"),s.push("0 g"),s.push("BT"),s.push("/"+t+" "+ai(o.fontSize)+" Tf "+i),s.push(o.text),s.push("ET"),s.push("Q"),e.stream=s.join(`
`),e},OffPushDown:function(r){var e=ro(r);e.scope=r.scope;var t=[];return t.push("0.749023 g"),t.push("0 0 "+ai(Vt.internal.getWidth(r))+" "+ai(Vt.internal.getHeight(r))+" re"),t.push("f"),e.stream=t.join(`
`),e}},RadioButton:{Circle:{createAppearanceStream:function(r){var e={D:{Off:Vt.RadioButton.Circle.OffPushDown},N:{}};return e.N[r]=Vt.RadioButton.Circle.YesNormal,e.D[r]=Vt.RadioButton.Circle.YesPushDown,e},getCA:function(){return"l"},YesNormal:function(r){var e=ro(r);e.scope=r.scope;var t=[],i=Vt.internal.getWidth(r)<=Vt.internal.getHeight(r)?Vt.internal.getWidth(r)/4:Vt.internal.getHeight(r)/4;i=Number((.9*i).toFixed(5));var s=Vt.internal.Bezier_C,n=Number((i*s).toFixed(5));return t.push("q"),t.push("1 0 0 1 "+fa(Vt.internal.getWidth(r)/2)+" "+fa(Vt.internal.getHeight(r)/2)+" cm"),t.push(i+" 0 m"),t.push(i+" "+n+" "+n+" "+i+" 0 "+i+" c"),t.push("-"+n+" "+i+" -"+i+" "+n+" -"+i+" 0 c"),t.push("-"+i+" -"+n+" -"+n+" -"+i+" 0 -"+i+" c"),t.push(n+" -"+i+" "+i+" -"+n+" "+i+" 0 c"),t.push("f"),t.push("Q"),e.stream=t.join(`
`),e},YesPushDown:function(r){var e=ro(r);e.scope=r.scope;var t=[],i=Vt.internal.getWidth(r)<=Vt.internal.getHeight(r)?Vt.internal.getWidth(r)/4:Vt.internal.getHeight(r)/4;i=Number((.9*i).toFixed(5));var s=Number((2*i).toFixed(5)),n=Number((s*Vt.internal.Bezier_C).toFixed(5)),a=Number((i*Vt.internal.Bezier_C).toFixed(5));return t.push("0.749023 g"),t.push("q"),t.push("1 0 0 1 "+fa(Vt.internal.getWidth(r)/2)+" "+fa(Vt.internal.getHeight(r)/2)+" cm"),t.push(s+" 0 m"),t.push(s+" "+n+" "+n+" "+s+" 0 "+s+" c"),t.push("-"+n+" "+s+" -"+s+" "+n+" -"+s+" 0 c"),t.push("-"+s+" -"+n+" -"+n+" -"+s+" 0 -"+s+" c"),t.push(n+" -"+s+" "+s+" -"+n+" "+s+" 0 c"),t.push("f"),t.push("Q"),t.push("0 g"),t.push("q"),t.push("1 0 0 1 "+fa(Vt.internal.getWidth(r)/2)+" "+fa(Vt.internal.getHeight(r)/2)+" cm"),t.push(i+" 0 m"),t.push(i+" "+a+" "+a+" "+i+" 0 "+i+" c"),t.push("-"+a+" "+i+" -"+i+" "+a+" -"+i+" 0 c"),t.push("-"+i+" -"+a+" -"+a+" -"+i+" 0 -"+i+" c"),t.push(a+" -"+i+" "+i+" -"+a+" "+i+" 0 c"),t.push("f"),t.push("Q"),e.stream=t.join(`
`),e},OffPushDown:function(r){var e=ro(r);e.scope=r.scope;var t=[],i=Vt.internal.getWidth(r)<=Vt.internal.getHeight(r)?Vt.internal.getWidth(r)/4:Vt.internal.getHeight(r)/4;i=Number((.9*i).toFixed(5));var s=Number((2*i).toFixed(5)),n=Number((s*Vt.internal.Bezier_C).toFixed(5));return t.push("0.749023 g"),t.push("q"),t.push("1 0 0 1 "+fa(Vt.internal.getWidth(r)/2)+" "+fa(Vt.internal.getHeight(r)/2)+" cm"),t.push(s+" 0 m"),t.push(s+" "+n+" "+n+" "+s+" 0 "+s+" c"),t.push("-"+n+" "+s+" -"+s+" "+n+" -"+s+" 0 c"),t.push("-"+s+" -"+n+" -"+n+" -"+s+" 0 -"+s+" c"),t.push(n+" -"+s+" "+s+" -"+n+" "+s+" 0 c"),t.push("f"),t.push("Q"),e.stream=t.join(`
`),e}},Cross:{createAppearanceStream:function(r){var e={D:{Off:Vt.RadioButton.Cross.OffPushDown},N:{}};return e.N[r]=Vt.RadioButton.Cross.YesNormal,e.D[r]=Vt.RadioButton.Cross.YesPushDown,e},getCA:function(){return"8"},YesNormal:function(r){var e=ro(r);e.scope=r.scope;var t=[],i=Vt.internal.calculateCross(r);return t.push("q"),t.push("1 1 "+ai(Vt.internal.getWidth(r)-2)+" "+ai(Vt.internal.getHeight(r)-2)+" re"),t.push("W"),t.push("n"),t.push(ai(i.x1.x)+" "+ai(i.x1.y)+" m"),t.push(ai(i.x2.x)+" "+ai(i.x2.y)+" l"),t.push(ai(i.x4.x)+" "+ai(i.x4.y)+" m"),t.push(ai(i.x3.x)+" "+ai(i.x3.y)+" l"),t.push("s"),t.push("Q"),e.stream=t.join(`
`),e},YesPushDown:function(r){var e=ro(r);e.scope=r.scope;var t=Vt.internal.calculateCross(r),i=[];return i.push("0.749023 g"),i.push("0 0 "+ai(Vt.internal.getWidth(r))+" "+ai(Vt.internal.getHeight(r))+" re"),i.push("f"),i.push("q"),i.push("1 1 "+ai(Vt.internal.getWidth(r)-2)+" "+ai(Vt.internal.getHeight(r)-2)+" re"),i.push("W"),i.push("n"),i.push(ai(t.x1.x)+" "+ai(t.x1.y)+" m"),i.push(ai(t.x2.x)+" "+ai(t.x2.y)+" l"),i.push(ai(t.x4.x)+" "+ai(t.x4.y)+" m"),i.push(ai(t.x3.x)+" "+ai(t.x3.y)+" l"),i.push("s"),i.push("Q"),e.stream=i.join(`
`),e},OffPushDown:function(r){var e=ro(r);e.scope=r.scope;var t=[];return t.push("0.749023 g"),t.push("0 0 "+ai(Vt.internal.getWidth(r))+" "+ai(Vt.internal.getHeight(r))+" re"),t.push("f"),e.stream=t.join(`
`},t.outline.makeRef=function(i){return i.id+" 0 R"},t.outline.makeString=function(i){return"("+t.internal.pdfEscape(i)+")"},t.outline.objStart=function(i){this.ctx.val+=`\r
`+i.id+` 0 obj\r
<<\r
`},t.outline.objEnd=function(){this.ctx.val+=`>> \r
endobj\r
 * @license
 *
 * Copyright (c) 2014 James Robb, https://github.com/jamesbrobb
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 * ====================================================================
 *//**
 * @license
 * (c) Dean McNamee <dean@gmail.com>, 2013.
 *
 * https://github.com/deanm/omggif
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 *
 * omggif is a JavaScript implementation of a GIF 89a encoder and decoder,
 * including animation and compression.  It does not rely on any specific
 * underlying system, so should run in the browser, Node, or Plask.
 * @license
  Copyright (c) 2008, Adobe Systems Incorporated
  All rights reserved.

  Redistribution and use in source and binary forms, with or without 
  modification, are permitted provided that the following conditions are
  met:

  * Redistributions of source code must retain the above copyright notice, 
    this list of conditions and the following disclaimer.
  
  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the 
    documentation and/or other materials provided with the distribution.
  
  * Neither the name of Adobe Systems Incorporated nor the names of its 
    contributors may be used to endorse or promote products derived from 
    this software without specific prior written permission.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
  IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
  THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
  PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR 
  CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
  EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
  PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
  LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
  NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
  SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 * @license
 * Copyright (c) 2017 Aras Abbasi
 *
 * Licensed under the MIT License.
 * http://opensource.org/licenses/mit-license
<<
`+d.join(`
`)+`
12 dict begin
begincmap
/CIDSystemInfo <<
  /Registry (Adobe)
  /Ordering (UCS)
  /Supplement 0
>> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000><ffff>
`+l.length+` beginbfchar
`+l.join(`
`)+`
endbfchar`,l=[]),n[a]!==void 0&&n[a]!==null&&typeof n[a].toString=="function"&&(c=("0000"+n[a].toString(16)).slice(-4),a=("0000"+(+a).toString(16)).slice(-4),l.push("<"+a+"><"+c+">"));return l.length&&(A+=`
`+l.length+` beginbfchar
`+l.join(`
`)+`
endbfchar
`),A+=`endcmap
CMapName currentdict /CMap defineresource pop
end
`)}return""+t},e}();window.Viewer=$y;window.initViewer=uD;window.loadXeokitSDK=hD;window.jsPDF=Jt;export{Mi as _};
