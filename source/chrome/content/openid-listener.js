/* Look at incoming pages for OpenID forms and munge them.
   This is hacky and makes a lot of unjustified assumptions about forms. */

/* Listen for URLs that point to Weave OpenID provider and intercept */
var gOpenIDProviderListener = {
    QueryInterface: function(aIID) {
       if (aIID.equals(Components.interfaces.nsIWebProgressListener) ||
           aIID.equals(Components.interfaces.nsISupportsWeakReference) ||
           aIID.equals(Components.interfaces.nsISupports))
         return this;
       throw Components.results.NS_NOINTERFACE;
      },

      onLocationChange: function(aProgress, aRequest, aURI) {
        if (aURI)
          gOpenIdMunger.processNewURL(aURI, aProgress.DOMWindow);
      },

      onStateChange: function() {},
      onProgressChange: function() {},
      onStatusChange: function() {},
      onSecurityChange: function() {},
      onLinkIconAvailable: function() {}
}
const OPENID_SERVICE_URI = "services.mozilla.com/openid/";
const OPENID_PREF = "extensions.weave.openId.enabled";

/* When we find an openID field, grey it out and put the user's Weave-based openID URI into
 * it, while changing the submit button to say "Sign In with Weave".  But only do this if
 * OPENID_PREF is turned on.
 */

var gOpenIdMunger = {
  _prefs: null,
  get _prefs() {
      return Components.classes["@mozilla.org/preferences-service;1"]
        .getService(Components.interfaces.nsIPrefBranch);
  },

  init: function() {
    /* Listen for webpage loads */
    if ( gOpenIdMunger._prefs.getBoolPref( OPENID_PREF ) ) {
      if (typeof(gBrowser) != "undefined") {
        var appcontent = document.getElementById("appcontent");   // browser
        if(appcontent) {
          appcontent.addEventListener("DOMContentLoaded",
                                      gOpenIdMunger.detectForm, true);
        }
      }
    }

    /* Listen for redirects to Weave OpenID provider regardless of pref */
    if (typeof(gBrowser) != "undefined") {
        gBrowser.addProgressListener(gOpenIDProviderListener,
        Components.interfaces.nsIWebProgress.NOTIFY_STATE_DOCUMENT);
    }
  },

  uninit: function() {
    if ( gOpenIdMunger._prefs.getBoolPref( OPENID_PREF ) ) {
      if (typeof(gBrowser) != "undefined") {
        var appcontent = document.getElementById("appcontent");   // browser
        if(appcontent) {
          appcontent.removeEventListener("DOMContentLoaded",
                                      gOpenIdMunger.detectForm, true);
        }
      }
    }

    if (typeof(gBrowser) != "undefined")
      gBrowser.removeProgressListener(gOpenIDProviderListener);
  },
  
  detectForm: function(aEvent) {
    var theDoc = aEvent.originalTarget;
    let inputs = theDoc.getElementsByTagName("input");
    let i;

    // Can't replace OpenID fields without a weave id
    let weaveUsername = Weave.ID.get("WeaveID").username;
    if (weaveUsername == "")
      return;

    // Find text input fields for OpenID identifiers:
    for (i = 0; i < inputs.length; i++) {
      let elem = inputs.item(i);

      // OpenID 2.0 says inputs SHOULD be openid_identifier
      // http://openid.net/specs/openid-authentication-2_0.html#initiation
      // OpenID 1.1 says inputs SHOULD be openid_url
      // http://openid.net/specs/openid-authentication-1_1.html#anchor7
      // Open Web says sites don't follow that and use whatever they want
      // I say.. "I give up!"
      if (elem.type == "text" && elem.name.search(/openid/i) != -1) {
        /* Turn the text input field into a hidden field, and fill in the value with our
         * Weave-based OpenID identifier.  Trial and error shows that we have to set type
         * before we set value, because changing the type of a field seems to reset its value
         * to the one defined in the page.  Not sure if this is a DOM bug or purposeful
         * behavior but that seems to be how it works at least in firefox 3.5.
         */
        elem.type = "hidden";
        elem.value = OPENID_SERVICE_URI + weaveUsername;

        let form = elem.form;
        let formChildren = form.getElementsByTagName("input");
        // Find the submit button in the same form and change the text on the button:
        for (let j=0; j < formChildren.length; j++) {
          if (formChildren[j].type == "submit") {
            let submit = formChildren[j];
            let oldvalue = submit.value;
            submit.value = "Sign In Using Weave";
            let foo = submit.ownerDocument.createElement("span");
            let links = '<a href="#" id="revert"><small>(revert)</small></a>';

            foo.innerHTML = links;            
            foo.addEventListener('click', function() {
              elem.value = "";
              elem.type = "text";
              submit.value = oldvalue;
              submit.parentNode.removeChild(foo);
            }, false);
            
            submit.parentNode.insertBefore(foo, submit.nextSibling);
          }
        }
      }
    }
  },

  processNewURL: function(aURI, domWin) {
    let spec = aURI.spec;
    if (spec.substr(0, 37) ==
        'https://services.mozilla.com/openid/?') {

      let loadUrl = function(url) domWin.location = url;
      if (domWin.location != spec) {
        Array.forEach(domWin.document.getElementsByTagName("iframe"), function(frame) {
          if (frame.src == spec)
            loadUrl = function(url) frame.src = url;
        });
      }

      let redirect = function(url) {
        window.stop();
        loadUrl(url);
      };

      /* Stop the redirect */
      redirect("chrome://weave/content/openid-wait.xul");

      /* Parse tokens */
      let pstring = spec.substr(37);
      let params = pstring.split('&');
      let retURI = false;
      let rootURI = false;

      for (let i = 0; i < params.length; i++) {
        if (params[i].substr(0, 16)  == "openid.return_to") {
          retURI = params[i].split('=');
          retURI = decodeURIComponent(retURI[1]);
        }
        if (params[i].substr(0, 17)  == "openid.trust_root") {
          rootURI = params[i].split('=');
          rootURI = decodeURIComponent(rootURI[1]);
        }
      }

      if (!retURI) {
        /* No return_to was specified! */
        window.back();
      }

      /* Make the request */
      this.authorize(retURI, rootURI, redirect);
    }
  },

  authorize: function (rurl, root, cb) {
    let req = new XMLHttpRequest();
    let usr = Weave.ID.get('WeaveID').username;
    let pwd = Weave.ID.get('WeaveID').password;

    usr = "https://services.mozilla.com/openid/" + usr;
    let params = 'openid_identity=' + encodeURIComponent(usr);
    params = params + '&weave_pwd=' + encodeURIComponent(pwd);
    params = params + '&openid_return_to=' + encodeURIComponent(rurl);

    if (root)
      params = params + '&openid_trust_root=' + encodeURIComponent(root);

    let uri = 'https://services.mozilla.com/openid/?openid.mode=authorize_site';
    req.onreadystatechange = function(e) {
      if (req.readyState == 4) {
        /* Our job is to just redirect,
         * else everything has been setup by the server.
         * We don't even know if the auth succeeded or not, the consumer
         * will be informing the user.
         */
        cb(req.responseText);
      }
    };
    req.open('POST', uri);
    req.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
    req.setRequestHeader('Content-length', params.length);
    req.setRequestHeader('Connection', 'close');
    req.send(params);
  }
};

window.addEventListener("load", function() {gOpenIdMunger.init();}, false);
window.addEventListener("unload", function() {gOpenIdMunger.uninit();}, false);
