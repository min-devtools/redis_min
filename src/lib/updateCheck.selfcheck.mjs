// Mirror of isNewer() in updateCheck.ts — keep in sync. Run: node updateCheck.selfcheck.mjs
import assert from "node:assert";
function parse(v){const[c,p=""]=v.replace(/^v/,"").split("-");return{nums:c.split(".").map(n=>parseInt(n,10)||0),pre:p};}
function cmpPre(a,b){if(a===b)return 0;if(!a)return 1;if(!b)return -1;const as=a.split("."),bs=b.split(".");for(let i=0;i<Math.max(as.length,bs.length);i++){const x=as[i],y=bs[i];if(x===undefined)return -1;if(y===undefined)return 1;const nx=/^\d+$/.test(x),ny=/^\d+$/.test(y);if(nx&&ny){const d=+x-+y;if(d)return d<0?-1:1;}else if(x!==y)return x<y?-1:1;}return 0;}
function isNewer(l,c){const a=parse(l),b=parse(c);for(let i=0;i<3;i++){const d=(a.nums[i]??0)-(b.nums[i]??0);if(d!==0)return d>0;}return cmpPre(a.pre,b.pre)>0;}

assert(isNewer("1.0.1","1.0.0"));
assert(isNewer("1.1.0","1.0.9"));
assert(isNewer("v1.0.0","1.0.0-alpha"));          // release > prerelease
assert(isNewer("1.0.0-alpha.2","1.0.0-alpha"));   // more identifiers
assert(isNewer("1.0.0-alpha.10","1.0.0-alpha.2"));// numeric, not lexical
assert(!isNewer("1.0.0","1.0.0"));                // equal
assert(!isNewer("1.0.0-alpha","1.0.0"));          // prerelease < release
assert(!isNewer("0.9.0","1.0.0-alpha"));          // lower core
console.log("updateCheck selfcheck OK");
