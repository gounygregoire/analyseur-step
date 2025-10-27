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
return ret;
`),H+=`};
