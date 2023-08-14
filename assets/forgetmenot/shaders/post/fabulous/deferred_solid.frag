#include forgetmenot:shaders/lib/inc/header.glsl
#include forgetmenot:shaders/lib/inc/sky.glsl
#include forgetmenot:shaders/lib/inc/cubemap.glsl
#include forgetmenot:shaders/lib/inc/space.glsl
#include forgetmenot:shaders/lib/inc/noise.glsl
#include forgetmenot:shaders/lib/inc/packing.glsl
#include forgetmenot:shaders/lib/inc/material.glsl
#include forgetmenot:shaders/lib/inc/lighting.glsl
#include forgetmenot:shaders/lib/inc/sky_display.glsl

uniform sampler2D u_color;
uniform usampler2D u_data;
uniform sampler2D u_depth;
uniform sampler2D u_ambient_occlusion;

uniform sampler2DArrayShadow u_shadow_map;
uniform sampler2DArray u_shadow_tex;

uniform samplerCube u_skybox;

uniform sampler2D u_transmittance;
uniform sampler2D u_multiscattering;
uniform sampler2D u_sky_display;

uniform sampler2D u_smooth_uniforms;

uniform sampler2D u_light_data;

in vec2 texcoord;

layout(location = 0) out vec4 fragColor;

struct Hit {
	vec3 pos;
	vec3 normal;

	bool success;
};

const Hit NO_HIT = Hit(vec3(0.0), vec3(0.0), false);

bool evaluateHit(in vec3 voxelPos) {
	frx_LightData data = frx_getLightOcclusionData(u_light_data, voxelPos);

	return data.isOccluder && data.isFullCube;
}

Hit raytraceAo(vec3 rayPos, vec3 rayDir, int raytraceLength) {
	Hit hit = NO_HIT;

	rayPos += frx_cameraPos;

	vec3 stepSizes = 1.0 / abs(rayDir);
	vec3 stepDir = sign(rayDir);
	vec3 nextDist = (stepDir * 0.5 + 0.5 - fract(rayPos)) / rayDir;

	ivec3 voxelPos = ivec3(floor(rayPos));
	vec3 currentPos = rayPos;

	for(int i = 0; i < raytraceLength; i++) {
		float closestDist = min(nextDist.x, min(nextDist.y, nextDist.z));

		currentPos += rayDir * closestDist;

		vec3 stepAxis = vec3(lessThanEqual(nextDist, vec3(closestDist)));

		voxelPos += ivec3(stepAxis * stepDir);

		nextDist -= closestDist;
		nextDist += stepSizes * stepAxis;

		hit.normal = stepAxis;

		if(evaluateHit(voxelPos)) {
			hit.pos = currentPos - frx_cameraPos;
			hit.normal *= -stepDir;
			hit.success = true;
			break;
		}
	}

	return hit;
}

#ifdef FANCY_POWDER_SNOW
	// Controls the scale of the voxel raytrace
	// One minecraft block is equal to this many voxels
	const float voxelScale = 16.0;

	bool hitSnow(inout Hit hit, in vec3 voxelPos) {
		float dist = length(voxelPos - frx_cameraPos * voxelScale);
		dist += hash13(voxelPos) * 4.0 - 2.0;

		return dist > 16.0;
	}

	Hit raytraceSnow(vec3 rayPos, vec3 rayDir, int raytraceLength) {
		Hit hit;
		hit.pos = vec3(0.0);
		hit.success = false;

		rayPos += frx_cameraPos * voxelScale;

		vec3 stepSizes = 1.0 / abs(rayDir);
		vec3 stepDir = sign(rayDir);
		vec3 nextDist = (stepDir * 0.5 + 0.5 - fract(rayPos)) / rayDir;

		ivec3 voxelPos = ivec3(rayPos);
		vec3 currentPos = rayPos;

		for(int i = 0; i < raytraceLength; i++) {
			float closestDist = min(nextDist.x, min(nextDist.y, nextDist.z));

			currentPos += rayDir * closestDist;
			
			vec3 stepAxis = vec3(lessThanEqual(nextDist, vec3(closestDist)));

			voxelPos += ivec3(stepAxis * stepDir);

			nextDist -= closestDist;
			nextDist += stepSizes * stepAxis;

			hit.normal = stepAxis;

			if(hitSnow(hit, voxelPos)) {
				hit.pos = currentPos - frx_cameraPos * voxelScale;
				hit.normal *= -stepDir;
				break;
			}
		}

		return hit;
	}

	// x should be a random value
	vec3 getPowderSnowColor(float x) {
		return mix(vec3(1.0), vec3(0.7, 0.85, 1.0), x);
	}
#endif

void main() {
	initGlobals();

	// Sample everything first, use them later to give the GPU time to read the textures
	// packedSample is sampling an RGB32UI image so we put the most distance between the sample and the usage
	uvec3 packedSample = texture(u_data, texcoord).xyz;
	float depth = texture(u_depth, texcoord).r;
	vec3 color = texture(u_color, texcoord).rgb;
	vec3 albedo = color;

	vec3 viewDir = getViewDir();
	vec3 sceneSpacePos = setupSceneSpacePos(texcoord, depth);

	if(fmn_isModdedDimension) {
		color = mix(color, pow(color, vec3(2.2)), floor(depth));
		fragColor = vec4(color, 1.0);
		return;
	}

	float emission = clamp01(frx_luminance(color) - 1.0);

	Material material = unpackMaterial(packedSample);

	#ifdef REALISTIC_METALS
		if(material.f0 > 0.999) {
			fragColor = vec4(color, 1.0);
			return;
		}
	#endif

	#ifdef FANCY_POWDER_SNOW
		if(frx_playerEyeInSnow == 1 && !frx_isGui) {

			Hit hit = raytraceSnow(vec3(0.0), viewDir, 40);

			hit.pos -= 0.05 * hit.normal;
			float hitDistance = length(hit.pos / voxelScale);

			if(!hit.success && hitDistance < length(sceneSpacePos.xyz + material.vertexNormal.xyz * 0.0025)) {
				material.blockLight = frx_eyeBrightness.x;//= vec3(frx_eyeBrightness, exp(-max(0.0, hitDistance - 0.8) * 2.0));
				material.skyLight = frx_eyeBrightness.y;
				material.vanillaAo = exp(-max(0.0, hitDistance - 0.9) * 2.0);

				emission = 0.0;

				material.fragNormal = hit.normal;
				material.vertexNormal = hit.normal;
				
				sceneSpacePos = mix(sceneSpacePos, hit.pos / voxelScale, 1.0 - step(length(hit.pos), length(sceneSpacePos)));

				vec3 worldSpaceHitPos = hit.pos + frx_cameraPos * voxelScale;
				const float voxelTextureResolution = 1.0;
				color = getPowderSnowColor(hash13(floor(worldSpaceHitPos * voxelTextureResolution) / voxelTextureResolution));
			}
		}
	#endif

	// float dist = rayIntersectSphere(vec3(0.0, -300.0, 100.0), viewDir, 10.0);
	// vec3 spherePos = viewDir * max(0.0, dist);
	// vec3 sphereNormal = normalize(cross(dFdx(spherePos), dFdy(spherePos)));

	// if(dist >= 0.0 && dist < length(sceneSpacePos)) {
	// 	sceneSpacePos = spherePos;
	// 	color = vec3(1.0, 0.0, 0.0);
	// 	material.fragNormal = sphereNormal;
	// 	material.vertexNormal = sphereNormal;
	// 	material.skyLight = 1.0;
	// 	material.blockLight = 0.0;
	// 	material.vanillaAo = 1.0;
	// 	material.f0 = 0.0;
	// 	material.roughness = 1.0;
	// 	material.sssAmount = 0.0;
	// 	material.isWater = 0.0;
		
	// 	depth = sceneSpaceToScreenSpace(spherePos).z;

	// 	// fragColor.rgb = sphereNormal;
	// 	// return;
	// }

	if(depth < 1.0) {
		// #ifdef RTAO
		// 	float ambientOcclusion = 1.0;

		// 	const int numAoRays = RTAO_RAYS;
		// 	const float rayContribution = 1.0 / numAoRays;

		// 	const float aoStrength = RTAO_STRENGTH;

		// 	const int aoRange = 2;

		// 	vec3 rayPos = sceneSpacePos + material.vertexNormal * 0.01;

		// 	vec3 sunBounceAmount = vec3(0.0);
		// 	vec3 sunColor = textureLod(u_skybox, frx_skyLightVector, 2).rgb * 0.01;

		// 	for(int i = 0; i < numAoRays; i++) {
		// 		vec3 rayDir = generateCosineVector(material.fragNormal);

		// 		Hit hit = raytraceAo(rayPos, rayDir, aoRange + 1);
		// 		if(hit.success) {
		// 			float distToHit = distance(hit.pos, rayPos);
		// 			float aoDistanceFactor = smoothstep(float(aoRange), float(aoRange - 1), distToHit);

		// 			sunBounceAmount += getShadowFactor(
		// 				hit.pos,
		// 				hit.normal,
		// 				0.0,
		// 				true,
		// 				4, 
		// 				u_shadow_tex, 
		// 				u_shadow_map
		// 			);

		// 			ambientOcclusion -= rayContribution * aoStrength * aoDistanceFactor;
		// 		}
		// 	}

		// 	sunBounceAmount *= sunColor;

		// 	//ambientOcclusion = min(ambientOcclusion, material.vanillaAo);
		// #else
		// 	float ambientOcclusion = material.vanillaAo;
		// #endif

		vec2 rtaoSample = texture(u_ambient_occlusion, texcoord).rg;

		color = basicLighting(
			color,
			sceneSpacePos,
			material.vertexNormal,
			material.fragNormal,
			material.blockLight,
			material.skyLight,
			pow(rtaoSample.r, 1.5),
			material.f0,
			material.roughness,
			material.sssAmount,
			material.isWater,
			u_skybox,
			u_transmittance,
			u_shadow_map,
			u_shadow_tex,
			u_light_data,
			true,
			16,
			texelFetch(u_smooth_uniforms, ivec2(3, 0), 0).r,
			rtaoSample.g
		);

//		color = vec3(ambientOcclusion);

		//color = vec3(tMax * 0.5);

		// color = texture(u_multiscattering, texcoord).rgb;
		
	} else {
		color = texture(u_sky_display, texcoord).rgb;
	}

	fragColor = vec4(color, 1.0);
}