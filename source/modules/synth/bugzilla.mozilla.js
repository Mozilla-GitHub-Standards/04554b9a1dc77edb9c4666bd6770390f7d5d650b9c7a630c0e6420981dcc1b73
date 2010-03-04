/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Account Manager.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Dan Mills <thunder@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

let EXPORTED_SYMBOLS = ['desc'];

// note: scraped usernames end up with some leading whitespace,
// bugzilla should make it easier to scrape them (or just support the
// AMCD... ;)

let desc = {
  realmUri: 'https://bugzilla.mozilla.org/',
  realmClass: 'SynthRealm',
  matchingUris: [
    'https://bugzilla.mozilla.org'
  ],
  amcd: {
    _synth: {
      scrape: {
        username: "//a[@href='index.cgi?logout=1']/../child::text()[position()=last()]"
      }
    },
    "methods-username-password-form": {
      "connect": {
        method: "POST",
        "path":"/index.cgi",
        "params": {
          "username":"Bugzilla_login",
          "password":"Bugzilla_password"
        }
      },
      "disconnect": {
        method: "POST",
        "path":"/index.cgi?logout=1"
      },
      "query": {
        method: "GET",
        "path":"/"
      }
    }
  }
};
