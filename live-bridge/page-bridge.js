const SOURCE='ict-brain-web';
function announce(){window.postMessage({source:'ict-brain-extension',type:'ICT_EXTENSION_READY',version:'1.5.0'},'*');}
announce();
setInterval(announce,2500);
window.addEventListener('message',async event=>{if(event.source!==window)return;const m=event.data;if(!m||m.source!==SOURCE||m.type!=='ICT_EXTENSION_REQUEST'||!m.id)return;let response;try{response=await chrome.runtime.sendMessage(m.payload||{});}catch(error){response={ok:false,error:error?.message||'Extension request failed.'};}window.postMessage({source:'ict-brain-extension',type:'ICT_EXTENSION_RESPONSE',id:m.id,response},'*');});
