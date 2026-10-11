// The editor's shaders. Ground, models and water follow roBrowser's
// (src/Renderer/Map/Ground.*, Effects/Shaders/GLSL/Models.*, Map/Water.*,
// GPL-3.0) so the lighting is the game's; the ground reads its textures from
// an array rather than an atlas, so painting a new one never rebuilds it.

export const GROUND_VS = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec3 aNormal;
in vec2 aUV;
in float aLayer;
in vec2 aLightUV;
in vec2 aTileUV;
out vec2 vUV;
out float vLayer;
out vec2 vLightUV;
out vec2 vTileUV;
out float vLight;
out vec3 vWorld;
uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uLightDir;
void main() {
	gl_Position = uProj * uView * vec4(aPosition, 1.0);
	vUV = aUV; vLayer = aLayer; vLightUV = aLightUV; vTileUV = aTileUV; vWorld = aPosition;
	vLight = max(dot(aNormal, uLightDir), 0.0);
}`;

export const GROUND_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUV;
in float vLayer;
in vec2 vLightUV;
in vec2 vTileUV;
in float vLight;
in vec3 vWorld;
out vec4 frag;
uniform sampler2DArray uTextures;
uniform sampler2D uLightmap;
uniform sampler2D uTileColor;
uniform bool uUseLightmap;
uniform vec3 uAmbient;
uniform vec3 uDiffuse;
uniform vec3 uEnv;
uniform bool uGrid;
uniform vec4 uBrush;      // x, z, radius, on
uniform vec3 uBrushColor;
void main() {
	vec4 c = texture(uTextures, vec3(vUV, vLayer));
	if (c.a < 0.1) discard;
	if (vTileUV != vec2(0.0)) c *= texture(uTileColor, vTileUV);
	vec3 light = vLight * uDiffuse + uAmbient;
	c.rgb *= clamp(light, 0.0, 1.0);
	c.rgb *= clamp(uEnv, 0.0, 1.0);
	if (uUseLightmap) {
		vec4 lm = texture(uLightmap, vLightUV);
		c.rgb *= lm.a;
		c.rgb += clamp(lm.rgb, 0.0, 1.0);
	}
	if (uGrid) {
		vec2 g = abs(fract(vWorld.xz) - 0.5);
		float line = step(0.47, max(g.x, g.y));
		c.rgb = mix(c.rgb, vec3(0.0), line * 0.35);
	}
	if (uBrush.w > 0.5) {
		float d = distance(vWorld.xz, uBrush.xy);
		float ring = smoothstep(uBrush.z - 0.25, uBrush.z, d) * (1.0 - smoothstep(uBrush.z, uBrush.z + 0.25, d));
		float inside = 1.0 - smoothstep(0.0, uBrush.z, d);
		c.rgb = mix(c.rgb, uBrushColor, max(ring, inside * 0.18));
	}
	frag = vec4(c.rgb, 1.0);
}`;

export const MODEL_VS = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec3 aNormal;
in vec2 aUV;
in float aAlpha;
out vec2 vUV;
out float vLight;
out float vAlpha;
uniform mat4 uView;
uniform mat4 uProj;
uniform mat4 uModel;
uniform mat3 uNormalMat;
uniform vec3 uLightDir;
void main() {
	gl_Position = uProj * uView * uModel * vec4(aPosition, 1.0);
	vUV = aUV; vAlpha = aAlpha;
	vLight = max(dot(normalize(uNormalMat * aNormal), uLightDir), 0.0);
}`;

export const MODEL_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in float vLight;
in float vAlpha;
out vec4 frag;
uniform sampler2D uTexture;
uniform vec3 uAmbient;
uniform vec3 uDiffuse;
uniform vec3 uEnv;
uniform bool uUseLightmap;
uniform vec4 uTint;
void main() {
	vec4 c = texture(uTexture, vUV);
	if (c.a == 0.0) discard;
	vec3 light = (uUseLightmap ? vLight : 1.0) * uDiffuse + uAmbient;
	c.rgb *= clamp(light, 0.0, 1.0);
	c.rgb *= clamp(uEnv, 0.0, 1.0);
	c.a *= vAlpha;
	c.rgb = mix(c.rgb, uTint.rgb, uTint.a);
	frag = c;
}`;

export const WATER_VS = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat4 uView;
uniform mat4 uProj;
uniform float uWaveHeight;
uniform float uWavePitch;
uniform float uOffset;
const float PI = 3.14159265358979323846264;
void main() {
	float x = mod(aPosition.x, 2.0);
	float y = mod(aPosition.z, 2.0);
	float diff = x < 1.0 ? y < 1.0 ? 1.0 : -1.0 : 0.0;
	float h = sin((PI / 180.0) * (uOffset + 0.5 * uWavePitch * (aPosition.x + aPosition.z + diff))) * uWaveHeight;
	gl_Position = uProj * uView * vec4(aPosition.x, aPosition.y + h, aPosition.z, 1.0);
	vUV = aUV;
}`;

export const WATER_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 frag;
uniform sampler2D uTexture;
uniform float uOpacity;
void main() {
	vec4 c = texture(uTexture, vUV);
	frag = vec4(c.rgb, uOpacity);
}`;

// Flat-coloured geometry: the walkability overlay, areas, boxes, gizmos.
export const COLOR_VS = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec4 aColor;
out vec4 vColor;
uniform mat4 uView;
uniform mat4 uProj;
uniform mat4 uModel;
void main() {
	gl_Position = uProj * uView * uModel * vec4(aPosition, 1.0);
	vColor = aColor;
}`;

export const COLOR_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 frag;
void main() { frag = vColor; }`;

// Camera-facing sprites: NPCs, monsters, icons. Positions in world units,
// size in world units, anchored at the feet.
export const SPRITE_VS = `#version 300 es
precision highp float;
in vec2 aCorner;
out vec2 vUV;
uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uPos;
uniform vec2 uSize;
uniform vec2 uOrigin;   // feet, as a fraction of the size from the top left
void main() {
	vec3 right = vec3(uView[0][0], uView[1][0], uView[2][0]);
	vec3 up = vec3(uView[0][1], uView[1][1], uView[2][1]);
	vec2 c = aCorner - uOrigin;
	vec3 p = uPos + right * c.x * uSize.x - up * c.y * uSize.y;
	gl_Position = uProj * uView * vec4(p, 1.0);
	vUV = aCorner;
}`;

export const SPRITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 frag;
uniform sampler2D uTexture;
uniform vec4 uTint;
void main() {
	vec4 c = texture(uTexture, vUV);
	if (c.a < 0.05) discard;
	frag = vec4(mix(c.rgb, uTint.rgb, uTint.a), c.a);
}`;
