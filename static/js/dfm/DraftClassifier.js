// /static/js/dfm/DraftClassifier.js — UTF-8 (NO BOM)
// Classifie la dépouille par triangle vs un axe (X/Y/Z), avec tolérances.
// Entrées :
// geometry = { positions: Float32Array, indices: Uint16Array|Uint32Array, normals?: Float32Array|null }
// axis = {x:0|1, y:0|1, z:0|1}  // ex: X = {x:1,y:0,z:0}
// opts = { okMinDeg?:number, zeroTolDeg?:number, undercutMin?:number }
//
// Sortie : {
//   ok:       { tris: Uint32Array, count: number },
//   zero:     { tris: Uint32Array, count: number },
//   undercut: { tris: Uint32Array, count: number },
//   anglesDeg: Float32Array
// }
//
// Convention : draftDeg = 90° - acos( dot(n, axis) ).
//  ~0°  => dépouille nulle ; >0° => dépouille positive ; <0° => contre-dépouille.

export function classifyDraft(geometry, axis, opts) {
  const { positions, indices, normals = null } = geometry;
  if (!positions || !indices) {
    throw new Error("[DraftClassifier] positions/indices requis");
  }

  const ax = normalize([axis.x || 0, axis.y || 0, axis.z || 0]);
  if (ax[0] === 0 && ax[1] === 0 && ax[2] === 0) {
    throw new Error("[DraftClassifier] axe invalide");
  }

  const okMinDeg    = (opts?.okMinDeg    ?? 1.0);
  const zeroTolDeg  = (opts?.zeroTolDeg  ?? 0.5);
  const undercutMin = (opts?.undercutMin ?? -0.5);

  const triCount = (indices.length / 3) | 0;
  const angles   = new Float32Array(triCount);

  const okTris = [];
  const zeroTris = [];
  const underTris = [];

  const v0 = [0,0,0], v1 = [0,0,0], v2 = [0,0,0];
  const e1 = [0,0,0], e2 = [0,0,0], n  = [0,0,0];

  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t*3    ] * 3;
    const i1 = indices[t*3 + 1] * 3;
    const i2 = indices[t*3 + 2] * 3;

    v0[0]=positions[i0  ]; v0[1]=positions[i0+1]; v0[2]=positions[i0+2];
    v1[0]=positions[i1  ]; v1[1]=positions[i1+1]; v1[2]=positions[i1+2];
    v2[0]=positions[i2  ]; v2[1]=positions[i2+1]; v2[2]=positions[i2+2];

    if (normals && normals.length === positions.length) {
      const ni0 = i0, ni1 = i1, ni2 = i2;
      n[0] = (normals[ni0] + normals[ni1] + normals[ni2]) / 3;
      n[1] = (normals[ni0+1] + normals[ni1+1] + normals[ni2+1]) / 3;
      n[2] = (normals[ni0+2] + normals[ni1+2] + normals[ni2+2]) / 3;
      normalizeInPlace(n);
    } else {
      e1[0]=v1[0]-v0[0]; e1[1]=v1[1]-v0[1]; e1[2]=v1[2]-v0[2];
      e2[0]=v2[0]-v0[0]; e2[1]=v2[1]-v0[1]; e2[2]=v2[2]-v0[2];
      cross(n, e1, e2);
      normalizeInPlace(n);
    }

    const cosTheta = clamp(dot(n, ax), -1, 1);
    const thetaDeg = rad2deg(Math.acos(cosTheta));
    const draftDeg = 90 - thetaDeg;
    angles[t] = draftDeg;

    if (draftDeg >= okMinDeg) {
      okTris.push(t);
    } else if (Math.abs(draftDeg) <= zeroTolDeg) {
      zeroTris.push(t);
    } else if (draftDeg <= undercutMin) {
      underTris.push(t);
    }
  }

  return {
    ok:       { tris: toU32(okTris),       count: okTris.length },
    zero:     { tris: toU32(zeroTris),     count: zeroTris.length },
    undercut: { tris: toU32(underTris),    count: underTris.length },
    anglesDeg: angles
  };
}

// ---- helpers ----
function dot(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function cross(out,a,b){
  out[0]=a[1]*b[2]-a[2]*b[1];
  out[1]=a[2]*b[0]-a[0]*b[2];
  out[2]=a[0]*b[1]-a[1]*b[0];
  return out;
}
function len(a){ return Math.hypot(a[0],a[1],a[2]); }
function normalize(v){ const L=len(v); return L? [v[0]/L,v[1]/L,v[2]/L]:[0,0,0]; }
function normalizeInPlace(v){ const L=len(v); if(!L) return v; v[0]/=L; v[1]/=L; v[2]/=L; return v; }
function clamp(x,min,max){ return Math.min(max, Math.max(min,x)); }
function rad2deg(r){ return r*180/Math.PI; }
function toU32(arr){ const u=new Uint32Array(arr.length); for(let i=0;i<arr.length;i++) u[i]=arr[i]; return u; }
