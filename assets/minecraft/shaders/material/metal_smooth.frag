#include forgetmenot:shaders/lib/materials.glsl

void frx_materialFragment() {
	#ifdef PBR_ENABLED
		frx_fragReflectance = 1.0;
		frx_fragRoughness = 0.05 + 0.1 * frx_luminance(frx_fragColor.rgb);
		
		fmn_autoGenNormalStrength = 0.75;
	#endif
}
