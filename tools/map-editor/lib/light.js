// The light the shaders use, from the .rsw's global light, as roBrowser
// works it out (src/Renderer/MapRenderer.js, onWorldComplete): an "env"
// colour, and the direction toward the sun from longitude and latitude.

import { mat4 } from './mat.js';

export function lightUniforms(light) {
	const env = [0, 1, 2].map(i => 1 - (1 - light.diffuse[i]) * (1 - light.ambient[i]));
	const lon = (light.longitude * Math.PI) / 180, lat = (light.latitude * Math.PI) / 180;
	const m = mat4.create();
	// The original client rotates about X then Y, multiplying in reverse.
	mat4.rotateY(m, m, lon);
	mat4.rotateX(m, m, lat);
	const d = mat4.transformDir(m, [0, 1, 0]);
	return { env, direction: [-d[0], -d[1], -d[2]], diffuse: light.diffuse, ambient: light.ambient, opacity: light.opacity };
}
