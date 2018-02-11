const debug = require('electron').remote.getGlobal('main_debug');
const ipcRenderer = require('electron').ipcRenderer;
let samlRegx = new RegExp(/name="SAMLResponse"/, "i");

document.addEventListener("DOMContentLoaded", function () {
  let doc = document.documentElement.innerHTML;
  debug ("AzureAD document loaded");
  if (samlRegx.test(doc)) {
    let token = document.querySelector('input[name="SAMLResponse"]').value;
    debug("SAML token found in webview");
    //debug("SAML token contents: " + token);
    ipcRenderer.sendToHost('saml_token_found', token);
  }
});
