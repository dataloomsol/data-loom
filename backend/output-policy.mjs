import {redact} from './security.mjs';
// Defense in depth only. This is not a formal privacy or non-extraction guarantee.
export function guardAnswer(answer,source){
 if(typeof answer!=='string'||!answer.trim()||answer.length>6000)throw Error('Answer violates output length policy');
 const words=s=>s.toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
 const original=words(source),output=words(answer),runs=new Set();
 for(let i=0;i<=original.length-12;i++)runs.add(original.slice(i,i+12).join(' '));
 for(let i=0;i<=output.length-12;i++)if(runs.has(output.slice(i,i+12).join(' ')))throw Error('Answer contains a long verbatim source excerpt');
 const filtered=redact(answer);if(Object.values(filtered.counts).some(Boolean))throw Error('Answer contains a potential identifier or secret');
 return answer.trim();
}
