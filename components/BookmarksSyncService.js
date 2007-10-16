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
 * The Original Code is Bookmarks Sync.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2007
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

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

const MODE_RDONLY   = 0x01;
const MODE_WRONLY   = 0x02;
const MODE_CREATE   = 0x08;
const MODE_APPEND   = 0x10;
const MODE_TRUNCATE = 0x20;

const PERMS_FILE      = 0644;
const PERMS_DIRECTORY = 0755;

const STORAGE_FORMAT_VERSION = 0;

const ONE_BYTE = 1;
const ONE_KILOBYTE = 1024 * ONE_BYTE;
const ONE_MEGABYTE = 1024 * ONE_KILOBYTE;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

function BookmarksSyncService() { this._init(); }
BookmarksSyncService.prototype = {

  __bms: null,
  get _bms() {
    if (!this.__bms)
      this.__bms = Cc["@mozilla.org/browser/nav-bookmarks-service;1"].
                   getService(Ci.nsINavBookmarksService);
    return this.__bms;
  },

  __hsvc: null,
  get _hsvc() {
    if (!this.__hsvc)
      this.__hsvc = Cc["@mozilla.org/browser/nav-history-service;1"].
                    getService(Ci.nsINavHistoryService);
    return this.__hsvc;
  },

  __ans: null,
  get _ans() {
    if (!this.__ans)
      this.__ans = Cc["@mozilla.org/browser/annotation-service;1"].
                   getService(Ci.nsIAnnotationService);
    return this.__ans;
  },

  __ts: null,
  get _ts() {
    if (!this.__ts)
      this.__ts = Cc["@mozilla.org/browser/tagging-service;1"].
                  getService(Ci.nsITaggingService);
    return this.__ts;
  },

  __ls: null,
  get _ls() {
    if (!this.__ls)
      this.__ls = Cc["@mozilla.org/browser/livemark-service;2"].
        getService(Ci.nsILivemarkService);
    return this.__ls;
  },

  __ms: null,
  get _ms() {
    if (!this.__ms)
      this.__ms = Cc["@mozilla.org/microsummary/service;1"].
        getService(Ci.nsIMicrosummaryService);
    return this.__ms;
  },

  __os: null,
  get _os() {
    if (!this.__os)
      this.__os = Cc["@mozilla.org/observer-service;1"]
        .getService(Ci.nsIObserverService);
    return this.__os;
  },

  __dirSvc: null,
  get _dirSvc() {
    if (!this.__dirSvc)
      this.__dirSvc = Cc["@mozilla.org/file/directory_service;1"].
        getService(Ci.nsIProperties);
    return this.__dirSvc;
  },

  // Logger object
  _log: null,

  // Timer object for yielding to the main loop
  _timer: null,

  // Timer object for automagically syncing
  _scheduleTimer: null,

  // DAVCollection object
  _dav: null,

  // Last synced tree, version, and GUID (to detect if the store has
  // been completely replaced and invalidate the snapshot)
  _snapshot: {},
  _snapshotVersion: 0,

  __snapshotGUID: null,
  get _snapshotGUID() {
    if (!this.__snapshotGUID) {
      let uuidgen = Cc["@mozilla.org/uuid-generator;1"].
        getService(Ci.nsIUUIDGenerator);
      this.__snapshotGUID = uuidgen.generateUUID().toString().replace(/[{}]/g, '');
    }
    return this.__snapshotGUID;
  },
  set _snapshotGUID(GUID) {
    this.__snapshotGUID = GUID;
  },

  get currentUser() {
    return this._dav.currentUser;
  },

  _init: function BSS__init() {
    this._initLogs();
    this._log.info("Bookmarks Sync Service Initializing");

    let serverURL = 'https://dotmoz.mozilla.org/';
    let enabled = false;
    let schedule = 0;
    try {
      let branch = Cc["@mozilla.org/preferences-service;1"].
        getService(Ci.nsIPrefBranch);
      serverURL = branch.getCharPref("browser.places.sync.serverURL");
      enabled = branch.getBoolPref("browser.places.sync.enabled");
      schedule = branch.getIntPref("browser.places.sync.schedule");

      branch.addObserver("browser.places.sync", this, false);
    }
    catch (ex) { /* use defaults */ }

    this._log.info("Bookmarks login server: " + serverURL);
    this._dav = new DAVCollection(serverURL);
    this._readSnapshot();

    if (!enabled) {
      this._log.info("Bookmarks sync disabled");
      return;
    }

    switch (schedule) {
    case 0:
      this._log.info("Bookmarks sync enabled, manual mode");
      break;
    case 1:
      this._log.info("Bookmarks sync enabled, automagic mode");
      this._enableSchedule();
      break;
    default:
      this._log.info("Bookmarks sync enabled");
      this._log.info("Invalid schedule setting: " + schedule);
      break;
    }
  },

  _enableSchedule: function BSS__enableSchedule() {
    this._scheduleTimer = Cc["@mozilla.org/timer;1"].
      createInstance(Ci.nsITimer);
    let listener = new EventListener(bind2(this, this._onSchedule));
    this._scheduleTimer.initWithCallback(listener, 1800000, // 30 min
                                         this._scheduleTimer.TYPE_REPEATING_SLACK);
  },

  _disableSchedule: function BSS__disableSchedule() {
    this._scheduleTimer = null;
  },

  _onSchedule: function BSS__onSchedule() {
    this._log.info("Running scheduled sync");
    this.sync();
  },

  _initLogs: function BSS__initLogs() {
    let logSvc = Cc["@mozilla.org/log4moz/service;1"].
      getService(Ci.ILog4MozService);

    this._log = logSvc.getLogger("Service.Main");

    let formatter = logSvc.newFormatter("basic");
    let root = logSvc.rootLogger;
    root.level = root.LEVEL_ALL;

    let capp = logSvc.newAppender("console", formatter);
    capp.level = root.LEVEL_WARN;
    root.addAppender(capp);

    let dapp = logSvc.newAppender("dump", formatter);
    dapp.level = root.LEVEL_WARN;
    root.addAppender(dapp);

    let dirSvc = Cc["@mozilla.org/file/directory_service;1"].
      getService(Ci.nsIProperties);
    let logFile = dirSvc.get("ProfD", Ci.nsIFile);
    let verboseFile = logFile.clone();
    logFile.append("bm-sync.log");
    logFile.QueryInterface(Ci.nsILocalFile);
    verboseFile.append("bm-sync-verbose.log");
    verboseFile.QueryInterface(Ci.nsILocalFile);

    let fapp = logSvc.newFileAppender("rotating", logFile, formatter);
    fapp.level = root.LEVEL_INFO;
    root.addAppender(fapp);
    let vapp = logSvc.newFileAppender("rotating", verboseFile, formatter);
    vapp.level = root.LEVEL_ALL;
    root.addAppender(vapp);
  },

  _saveSnapshot: function BSS__saveSnapshot() {
    this._log.info("Saving snapshot to disk");

    let dirSvc = Cc["@mozilla.org/file/directory_service;1"].
      getService(Ci.nsIProperties);

    let file = dirSvc.get("ProfD", Ci.nsIFile);
    file.append("bm-sync-snapshot.json");
    file.QueryInterface(Ci.nsILocalFile);

    if (!file.exists())
      file.create(file.NORMAL_FILE_TYPE, PERMS_FILE);

    let fos = Cc["@mozilla.org/network/file-output-stream;1"].
      createInstance(Ci.nsIFileOutputStream);
    let flags = MODE_WRONLY | MODE_CREATE | MODE_TRUNCATE;
    fos.init(file, flags, PERMS_FILE, 0);

    let out = {version: this._snapshotVersion,
               GUID: this._snapshotGUID,
               snapshot: this._snapshot};
    out = uneval(out);
    fos.write(out, out.length);
    fos.close();
  },

  _readSnapshot: function BSS__readSnapshot() {
    let dirSvc = Cc["@mozilla.org/file/directory_service;1"].
      getService(Ci.nsIProperties);

    let file = dirSvc.get("ProfD", Ci.nsIFile);
    file.append("bm-sync-snapshot.json");

    if (!file.exists())
      return;

    let fis = Cc["@mozilla.org/network/file-input-stream;1"].
      createInstance(Ci.nsIFileInputStream);
    fis.init(file, MODE_RDONLY, PERMS_FILE, 0);
    fis.QueryInterface(Ci.nsILineInputStream);

    let json = "";
    while (fis.available()) {
      let ret = {};
      fis.readLine(ret);
      json += ret.value;
    }
    fis.close();
    json = eval(json);

    if (json && 'snapshot' in json && 'version' in json && 'GUID' in json) {
      this._log.info("Read saved snapshot from disk");
      this._snapshot = json.snapshot;
      this._snapshotVersion = json.version;
      this._snapshotGUID = json.GUID;
    }
  },

  _wrapNode: function BSS__wrapNode(node) {
    var items = {};
    this._wrapNodeInternal(node, items, null, null);
    return items;
  },

  _wrapNodeInternal: function BSS__wrapNodeInternal(node, items, parentGUID, index) {
    let GUID = this._bms.getItemGUID(node.itemId);
    let item = {parentGUID: parentGUID,
                index: index};

    if (node.type == node.RESULT_TYPE_FOLDER) {
      if (this._ls.isLivemark(node.itemId)) {
        item.type = "livemark";
        item.siteURI = this._ls.getSiteURI(node.itemId).spec;
        item.feedURI = this._ls.getFeedURI(node.itemId).spec;
      } else {
        item.type = "folder";
        node.QueryInterface(Ci.nsINavHistoryQueryResultNode);
        node.containerOpen = true;
        for (var i = 0; i < node.childCount; i++) {
          this._wrapNodeInternal(node.getChild(i), items, GUID, i);
        }
      }
      item.title = node.title;
    } else if (node.type == node.RESULT_TYPE_URI) {
      if (this._ms.hasMicrosummary(node.itemId)) {
        item.type = "microsummary";
        let micsum = this._ms.getMicrosummary(node.itemId);
        item.generatorURI = micsum.generator.uri.spec; // FIXME: might not be a remote generator!
      } else {
        item.type = "bookmark";
        item.title = node.title;
      }
      item.URI = node.uri;
      item.tags = this._ts.getTagsForURI(makeURI(node.uri));
      item.keyword = this._bms.getKeywordForBookmark(node.itemId);
    } else if (node.type == node.RESULT_TYPE_SEPARATOR) {
      item.type = "separator";
    } else if (node.type == node.RESULT_TYPE_QUERY) {
      item.type = "query";
    } else {
      this._log.warn("Warning: unknown item type, cannot serialize: " + node.type);
      return;
    }

    items[GUID] = item;
  },

  // FIXME: this won't work for deep objects, or objects with optional properties
  _getEdits: function BSS__getEdits(a, b) {
    // check the type separately, just in case
    if (a.type != b.type)
      return -1;

    let ret = {numProps: 0, props: {}};
    for (prop in a) {
      if (!this._deepEquals(a[prop], b[prop])) {
        ret.numProps++;
        ret.props[prop] = b[prop];
      }
    }

    // FIXME: prune out properties we don't care about

    return ret;
  },

  _nodeParents: function BSS__nodeParents(GUID, tree) {
    return this._nodeParentsInt(GUID, tree, []);
  },

  _nodeParentsInt: function BSS__nodeParentsInt(GUID, tree, parents) {
    if (!tree[GUID] || !tree[GUID].parentGUID)
      return parents;
    parents.push(tree[GUID].parentGUID);
    return this._nodeParentsInt(tree[GUID].parentGUID, tree, parents);
  },

  _detectUpdates: function BSS__detectUpdates(a, b) {
    let cmds = [];
    for (let GUID in a) {
      if (GUID in b) {
        let edits = this._getEdits(a[GUID], b[GUID]);
        if (edits == -1) // something went very wrong -- FIXME
          continue;
        if (edits.numProps == 0) // no changes - skip
          continue;
        let parents = this._nodeParents(GUID, b);
        cmds.push({action: "edit", GUID: GUID,
                   depth: parents.length, parents: parents,
                   data: edits.props});
      } else {
        let parents = this._nodeParents(GUID, a); // ???
        cmds.push({action: "remove", GUID: GUID,
                   depth: parents.length, parents: parents});
      }
    }
    for (let GUID in b) {
      if (GUID in a)
        continue;
      let parents = this._nodeParents(GUID, b);
      cmds.push({action: "create", GUID: GUID,
                 depth: parents.length, parents: parents,
                 data: b[GUID]});
    }
    cmds.sort(function(a, b) {
      if (a.depth > b.depth)
        return 1;
      if (a.depth < b.depth)
        return -1;
      if (a.index > b.index)
        return -1;
      if (a.index < b.index)
        return 1;
      return 0; // should never happen, but not a big deal if it does
    });
    return cmds;
  },

  // Bookmarks are allowed to be in a different index as long as they
  // are in the same folder.  Folders and separators must be at the
  // same index to qualify for 'likeness'.
  _commandLike: function BSS__commandLike(a, b) {

    // Check that neither command is null, that their actions, types,
    // and parents are the same, and that they don't have the same
    // GUID.
    // Items with the same GUID do not qualify because they need to be
    // processed for edits.
    // The parent GUID check works because reconcile() fixes up the
    // parent GUIDs as it runs, and the command list is sorted by
    // depth
    if (!a || !b ||
       a.action != b.action ||
       a.data.type != b.data.type ||
       a.parentGUID != b.parentGUID ||
       a.GUID == b.GUID)
      return false;

    switch (a.data.type) {
    case "bookmark":
      if (a.data.URI == b.data.URI &&
          a.data.title == b.data.title)
        return true;
      return false;
    case "microsummary":
      if (a.data.URI == b.data.URI &&
          a.data.generatorURI == b.data.generatorURI)
        return true;
      return false;
    case "folder":
      if (a.index == b.index &&
          a.data.title == b.data.title)
        return true;
      return false;
    case "livemark":
      if (a.data.title == b.data.title &&
          a.data.siteURI == b.data.siteURI &&
          a.data.feedURI == b.data.feedURI)
        return true;
      return false;
    case "separator":
      if (a.index == b.index)
        return true;
      return false;
    default:
      this._log.error("_commandLike: Unknown item type: " + uneval(a));
      return false;
    }
  },

  _deepEquals: function BSS__commandEquals(a, b) {
    if (!a && !b)
      return true;
    if (!a || !b)
      return false;

    for (let key in a) {
      if (typeof(a[key]) == "object") {
        if (!typeof(b[key]) == "object")
          return false;
        if (!this._deepEquals(a[key], b[key]))
          return false;
      } else {
        if (a[key] != b[key])
          return false;
      }
    }
    return true;
  },

  // When we change the GUID of a local item (because we detect it as
  // being the same item as a remote one), we need to fix any other
  // local items that have it as their parent
  _fixParents: function BSS__fixParents(list, oldGUID, newGUID) {
    for (let i = 0; i < list.length; i++) {
      if (!list[i])
        continue;
      if (list[i].parentGUID == oldGUID)
        list[i].parentGUID = newGUID;
      for (let j = 0; j < list[i].parents.length; j++) {
        if (list[i].parents[j] == oldGUID)
          list[i].parents[j] = newGUID;
      }
    }
  },

  _conflicts: function BSS__conflicts(a, b) {
    if ((a.GUID == b.GUID) && !this._deepEquals(a, b))
      return true;
    return false;
  },

  _getPropagations: function BSS__getPropagations(commands, conflicts, propagations) {
    for (let i = 0; i < commands.length; i++) {
      let alsoConflicts = function(elt) {
        return (elt.action == "create" || elt.action == "remove") &&
          commands[i].parents.indexOf(elt.GUID) >= 0;
      };
      if (conflicts.some(alsoConflicts))
        conflicts.push(commands[i]);

      let cmdConflicts = function(elt) {
        return elt.GUID == commands[i].GUID;
      };
      if (!conflicts.some(cmdConflicts))
        propagations.push(commands[i]);
    }
  },

  _reconcile: function BSS__reconcile(onComplete, listA, listB) {
    let cont = yield;
    let listener = new EventListener(cont);
    this._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);

    let propagations = [[], []];
    let conflicts = [[], []];

    for (let i = 0; i < listA.length; i++) {
      this._timer.initWithCallback(listener, 0, this._timer.TYPE_ONE_SHOT);
      yield; // Yield to main loop

      for (let j = 0; j < listB.length; j++) {
        if (this._deepEquals(listA[i], listB[j])) {
          delete listA[i];
          delete listB[j];
        } else if (this._commandLike(listA[i], listB[j])) {
          this._fixParents(listA, listA[i].GUID, listB[j].GUID);
          listB[j].data = {GUID: listB[j].GUID};
          listB[j].GUID = listA[i].GUID;
          listB[j].action = "edit";
          delete listA[i];
        }

        // watch out for create commands with GUIDs that already exist
        if (listB[j] && listB[j].action == "create" &&
            this._bms.getItemIdForGUID(listB[j].GUID) >= 0) {
          this._log.error("Remote command has GUID that already exists " +
                          "locally. Dropping command.");
          delete listB[j];
        }
      }
    }

    listA = listA.filter(function(elt) { return elt });
    listB = listB.filter(function(elt) { return elt });

    for (let i = 0; i < listA.length; i++) {
      this._timer.initWithCallback(listener, 0, this._timer.TYPE_ONE_SHOT);
      yield; // Yield to main loop

      for (let j = 0; j < listB.length; j++) {
        if (this._conflicts(listA[i], listB[j]) ||
            this._conflicts(listB[j], listA[i])) {
          if (!conflicts[0].some(
            function(elt) { return elt.GUID == listA[i].GUID }))
            conflicts[0].push(listA[i]);
          if (!conflicts[1].some(
            function(elt) { return elt.GUID == listB[j].GUID }))
            conflicts[1].push(listB[j]);
        }
      }
    }

    this._getPropagations(listA, conflicts[0], propagations[1]);

    this._timer.initWithCallback(listener, 0, this._timer.TYPE_ONE_SHOT);
    yield; // Yield to main loop

    this._getPropagations(listB, conflicts[1], propagations[0]);

    this._timer = null;
    let ret = {propagations: propagations, conflicts: conflicts};
    generatorDone(this, onComplete, ret);
  },

  _applyCommandsToObj: function BSS__applyCommandsToObj(commands, obj) {
    for (let i = 0; i < commands.length; i++) {
      this._log.debug("Applying cmd to obj: " + uneval(commands[i]));
      switch (commands[i].action) {
      case "create":
        obj[commands[i].GUID] = eval(uneval(commands[i].data));
        break;
      case "edit":
        if ("GUID" in commands[i].data) {
          // special-case guid changes
          let newGUID = commands[i].data.GUID,
              oldGUID = commands[i].GUID;

          obj[newGUID] = obj[oldGUID];
          delete obj[oldGUID]

          for (let GUID in obj) {
            if (obj[GUID].parentGUID == oldGUID)
              obj[GUID].parentGUID = newGUID;
          }
        }
        for (let prop in commands[i].data) {
          if (prop == "GUID")
            continue;
          obj[commands[i].GUID][prop] = commands[i].data[prop];
        }
        break;
      case "remove":
        delete obj[commands[i].GUID];
        break;
      }
    }
    return obj;
  },

  // Applies commands to the places db
  _applyCommands: function BSS__applyCommands(commandList) {
    for (var i = 0; i < commandList.length; i++) {
      var command = commandList[i];
      this._log.debug("Processing command: " + uneval(command));
      switch (command["action"]) {
      case "create":
        this._createCommand(command);
        break;
      case "remove":
        this._removeCommand(command);
        break;
      case "edit":
        this._editCommand(command);
        break;
      default:
        this._log.error("unknown action in command: " + command["action"]);
        break;
      }
    }
  },

  _createCommand: function BSS__createCommand(command) {
    let newId;
    let parentId = this._bms.getItemIdForGUID(command.data.parentGUID);

    if (parentId < 0) {
      this._log.warn("Creating node with unknown parent -> reparenting to root");
      parentId = this._bms.bookmarksRoot;
    }

    switch (command.data.type) {
    case "bookmark":
    case "microsummary":
      this._log.info(" -> creating bookmark \"" + command.data.title + "\"");
      let URI = makeURI(command.data.URI);
      newId = this._bms.insertBookmark(parentId,
                                       URI,
                                       command.data.index,
                                       command.data.title);
      this._ts.untagURI(URI, null);
      this._ts.tagURI(URI, command.data.tags);
      this._bms.setKeywordForBookmark(newId, command.data.keyword);

      if (command.data.type == "microsummary") {
        this._log.info("   \-> is a microsummary");
        let genURI = makeURI(command.data.generatorURI);
        let micsum = this._ms.createMicrosummary(URI, genURI);
        this._ms.setMicrosummary(newId, micsum);
      }
      break;
    case "folder":
      this._log.info(" -> creating folder \"" + command.data.title + "\"");
      newId = this._bms.createFolder(parentId,
                                     command.data.title,
                                     command.data.index);
      break;
    case "livemark":
      this._log.info(" -> creating livemark \"" + command.data.title + "\"");
      newId = this._ls.createLivemark(parentId,
                                      command.data.title,
                                      makeURI(command.data.siteURI),
                                      makeURI(command.data.feedURI),
                                      command.data.index);
      break;
    case "separator":
      this._log.info(" -> creating separator");
      newId = this._bms.insertSeparator(parentId, command.data.index);
      break;
    default:
      this._log.error("_createCommand: Unknown item type: " + command.data.type);
      break;
    }
    if (newId)
      this._bms.setItemGUID(newId, command.GUID);
  },

  _removeCommand: function BSS__removeCommand(command) {
    var itemId = this._bms.getItemIdForGUID(command.GUID);
    var type = this._bms.getItemType(itemId);

    switch (type) {
    case this._bms.TYPE_BOOKMARK:
      this._log.info("  -> removing bookmark " + command.GUID);
      this._bms.removeItem(itemId);
      break;
    case this._bms.TYPE_FOLDER:
      this._log.info("  -> removing folder " + command.GUID);
      this._bms.removeFolder(itemId);
      break;
    case this._bms.TYPE_SEPARATOR:
      this._log.info("  -> removing separator " + command.GUID);
      this._bms.removeItem(itemId);
      break;
    default:
      this._log.error("removeCommand: Unknown item type: " + type);
      break;
    }
  },

  _editCommand: function BSS__editCommand(command) {
    var itemId = this._bms.getItemIdForGUID(command.GUID);
    if (itemId < 0) {
      this._log.warn("Item for GUID " + command.GUID + " not found.  Skipping.");
      return;
    }

    for (let key in command.data) {
      switch (key) {
      case "GUID":
        var existing = this._bms.getItemIdForGUID(command.data.GUID);
        if (existing < 0)
          this._bms.setItemGUID(itemId, command.data.GUID);
        else
          this._log.warn("Can't change GUID " + command.GUID +
                         " to " + command.data.GUID + ": GUID already exists.");
        break;
      case "title":
        this._bms.setItemTitle(itemId, command.data.title);
        break;
      case "URI":
        this._bms.changeBookmarkURI(itemId, makeURI(command.data.URI));
        break;
      case "index":
        this._bms.moveItem(itemId, this._bms.getFolderIdForItem(itemId),
                           command.data.index);
        break;
      case "parentGUID":
        let index = -1;
        if (command.data.index && command.data.index >= 0)
          index = command.data.index;
        this._bms.moveItem(
          itemId, this._bms.getItemIdForGUID(command.data.parentGUID), index);
        break;
      case "tags":
        let tagsURI = this._bms.getBookmarkURI(itemId);
        this._ts.untagURI(URI, null);
        this._ts.tagURI(tagsURI, command.data.tags);
        break;
      case "keyword":
        this._bms.setKeywordForBookmark(itemId, command.data.keyword);
        break;
      case "generatorURI":
        let micsumURI = makeURI(this._bms.getBookmarkURI(itemId));
        let genURI = makeURI(command.data.generatorURI);
        let micsum = this._ms.createMicrosummary(micsumURI, genURI);
        this._ms.setMicrosummary(itemId, micsum);
        break;
      case "siteURI":
        this._ls.setSiteURI(itemId, makeURI(command.data.siteURI));
        break;
      case "feedURI":
        this._ls.setFeedURI(itemId, makeURI(command.data.feedURI));
        break;
      default:
        this._log.warn("Can't change item property: " + key);
        break;
      }
    }
  },

  _getWrappedBookmarks: function BSS__getWrappedBookmarks(folder) {
    let query = this._hsvc.getNewQuery();
    query.setFolders([folder], 1);
    let root = this._hsvc.executeQuery(query,
                                       this._hsvc.getNewQueryOptions()).root;
    return this._wrapNode(root);
  },

  _getBookmarks: function BSS__getBookmarks() {
    let filed = this._getWrappedBookmarks(this._bms.bookmarksRoot);
    let unfiled = this._getWrappedBookmarks(this._bms.unfiledRoot);

    for (let guid in unfiled) {
      if (guid in filed)
        this._log.warn("Same bookmark (guid) in both " +
                       "filed and unfiled trees!");
      else
        filed[guid] = unfiled[guid];
    }

    return filed; // (combined)
  },

  _mungeNodes: function BSS__mungeNodes(nodes) {
    let json = uneval(nodes);
    json = json.replace(/:{type/g, ":\n\t{type");
    json = json.replace(/}, /g, "},\n  ");
    json = json.replace(/, parentGUID/g, ",\n\t parentGUID");
    json = json.replace(/, index/g, ",\n\t index");
    json = json.replace(/, title/g, ",\n\t title");
    json = json.replace(/, URI/g, ",\n\t URI");
    json = json.replace(/, tags/g, ",\n\t tags");
    json = json.replace(/, keyword/g, ",\n\t keyword");
    return json;
  },

  _mungeCommands: function BSS__mungeCommands(commands) {
    let json = uneval(commands);
    json = json.replace(/ {action/g, "\n {action");
    //json = json.replace(/, data/g, ",\n  data");
    return json;
  },

  _mungeConflicts: function BSS__mungeConflicts(conflicts) {
    let json = uneval(conflicts);
    json = json.replace(/ {action/g, "\n {action");
    //json = json.replace(/, data/g, ",\n  data");
    return json;
  },

  //       original
  //         / \
  //      A /   \ B
  //       /     \
  // client --C-> server
  //       \     /
  //      D \   / C
  //         \ /
  //        final

  // If we have a saved snapshot, original == snapshot.  Otherwise,
  // it's the empty set {}.

  // C is really the diff between server -> final, so if we determine
  // D we can calculate C from that.  In the case where A and B have
  // no conflicts, C == A and D == B.

  // Sync flow:
  // 1) Fetch server deltas
  // 1.1) Construct current server status from snapshot + server deltas
  // 1.2) Generate single delta from snapshot -> current server status ("B")
  // 2) Generate local deltas from snapshot -> current client status ("A")
  // 3) Reconcile client/server deltas and generate new deltas for them.
  //    Reconciliation won't generate C directly, we will simply diff
  //    server->final after step 3.1.
  // 3.1) Apply local delta with server changes ("D")
  // 3.2) Append server delta to the delta file and upload ("C")

  _doSync: function BSS__doSync() {
    let cont = yield;
    try {
      if (!this._dav.lock.async(this._dav, cont))
        return;
      let locked = yield;

      if (locked)
        this._log.info("Lock acquired");
      else {
        this._log.warn("Could not acquire lock, aborting sync");
        return;
      }

      // 1) Fetch server deltas
      if (!this._getServerData.async(this, cont))
        return
      let server = yield;

      var localJson = this._getBookmarks();

      this._log.debug("local json:\n" + this._mungeNodes(localJson));
      this._log.info("Local snapshot version: " + this._snapshotVersion);
      this._log.info("Server status: " + server.status);

      if (server.status != 0) {
        this._log.fatal("Sync error: could not get server status, " +
                        "or initial upload failed.  Aborting sync.");
        return;
      }

      this._log.info("Server maxVersion: " + server.maxVersion);
      this._log.info("Server snapVersion: " + server.snapVersion);
      this._log.debug("Server updates: " + this._mungeCommands(server.updates));

      // 2) Generate local deltas from snapshot -> current client status

      let localUpdates = this._detectUpdates(this._snapshot, localJson);
      this._log.debug("Local updates: " + this._mungeCommands(localUpdates));

      if (server.updates.length == 0 && localUpdates.length == 0) {
        this._snapshotVersion = server.maxVersion;
        this._log.info("Sync complete (1): no changes needed on client or server");
        return;
      }
	  
      // 3) Reconcile client/server deltas and generate new deltas for them.

      this._log.info("Reconciling client/server updates");
      if (!this._reconcile.async(this, cont, localUpdates, server.updates))
        return
      let ret = yield;

      // FIXME: Need to come up with a closing protocol for generators
      //rec_gen.close();

      let clientChanges = [];
      let serverChanges = [];
      let clientConflicts = [];
      let serverConflicts = [];

      if (ret.propagations[0])
        clientChanges = ret.propagations[0];
      if (ret.propagations[1])
        serverChanges = ret.propagations[1];

      if (ret.conflicts && ret.conflicts[0])
        clientConflicts = ret.conflicts[0];
      if (ret.conflicts && ret.conflicts[1])
        serverConflicts = ret.conflicts[1];

      this._log.info("Changes for client: " + clientChanges.length);
      this._log.info("Changes for server: " + serverChanges.length);
      this._log.info("Client conflicts: " + clientConflicts.length);
      this._log.info("Server conflicts: " + serverConflicts.length);
      this._log.debug("Changes for client: " + this._mungeCommands(clientChanges));
      this._log.debug("Changes for server: " + this._mungeCommands(serverChanges));
      this._log.debug("Client conflicts: " + this._mungeConflicts(clientConflicts));
      this._log.debug("Server conflicts: " + this._mungeConflicts(serverConflicts));

      if (!(clientChanges.length || serverChanges.length ||
            clientConflicts.length || serverConflicts.length)) {
        this._log.info("Sync complete (2): no changes needed on client or server");
        this._snapshot = localJson;
        this._snapshotVersion = server.maxVersion;
        this._saveSnapshot();
        return;
      }

      if (clientConflicts.length || serverConflicts.length) {
        this._log.warn("Conflicts found!  Discarding server changes");
      }

      // 3.1) Apply server changes to local store
      if (clientChanges.length) {
        this._log.info("Applying changes locally");
        // Note that we need to need to apply client changes to the
        // current tree, not the saved snapshot

        this._snapshot = this._applyCommandsToObj(clientChanges, localJson);
        this._snapshotVersion = server.maxVersion;
        this._applyCommands(clientChanges);

        let newSnapshot = this._getBookmarks();
        let diff = this._detectUpdates(this._snapshot, newSnapshot);
        if (diff.length != 0) {
          this._log.error("Commands did not apply correctly");
          this._log.debug("Diff from snapshot+commands -> " +
                          "new snapshot after commands:\n" +
                          this._mungeCommands(diff));
          this._snapshot = newSnapshot;
          // FIXME: What else can we do?
        }
        this._saveSnapshot();
      }

      // 3.2) Append server delta to the delta file and upload

      // Generate a new diff, from the current server snapshot to the
      // current client snapshot.  In the case where there are no
      // conflicts, it should be the same as what the resolver returned

      let serverDelta = this._detectUpdates(server.snapshot, this._snapshot);

      // Log an error if not the same
      if (!(serverConflicts.length ||
            this._deepEquals(serverChanges, serverDelta)))
        this._log.error("Predicted server changes differ from " +
                        "actual server->client diff");

      if (serverDelta.length) {
        this._log.info("Uploading changes to server");
        this._snapshot = this._getBookmarks();
        this._snapshotVersion = ++server.maxVersion;
        server.deltas.push(serverDelta);

        this._dav.PUT("bookmarks-deltas.json",
                      this._mungeCommands(server.deltas), cont);
        let deltasPut = yield;

        // FIXME: need to watch out for the storage format version changing,
        // in that case we'll have to re-upload all the files, not just these
        this._dav.PUT("bookmarks-status.json",
                      uneval({GUID: this._snapshotGUID,
                              formatVersion: STORAGE_FORMAT_VERSION,
                              snapVersion: server.snapVersion,
                              maxVersion: this._snapshotVersion}), cont);
        let statusPut = yield;

        if (deltasPut.target.status >= 200 && deltasPut.target.status < 300 &&
            statusPut.target.status >= 200 && statusPut.target.status < 300) {
          this._log.info("Successfully updated deltas and status on server");
          this._saveSnapshot();
        } else {
          // FIXME: revert snapshot here? - can't, we already applied
          // updates locally! - need to save and retry
          this._log.error("Could not update deltas on server");
        }
      }
      this._log.info("Sync complete");
    } finally {
      this._os.notifyObservers(null, "bookmarks-sync:end", "");
      if (!this._dav.unlock.async(this._dav, cont))
        return;
      let unlocked = yield;
      if (unlocked)
        this._log.info("Lock released");
      else
        this._log.error("Could not unlock DAV collection");
    }
  },

  _getFolderNodes: function BSS__getFolderNodes(folder) {
    let query = this._hsvc.getNewQuery();
    query.setFolders([folder], 1);
    return this._hsvc.executeQuery(query, this._hsvc.getNewQueryOptions()).root;
  },

  _resetGUIDs: function BSS__resetGUIDs() {
    this._resetGUIDsInt(this._getFolderNodes(this._bms.bookmarksRoot));
    this._resetGUIDsInt(this._getFolderNodes(this._bms.unfiledRoot));
  },

  _resetGUIDsInt: function BSS__resetGUIDsInt(node) {
    if (this._ans.itemHasAnnotation(node.itemId, "placesInternal/GUID"))
      this._ans.removeItemAnnotation(node.itemId, "placesInternal/GUID");

    if (node.type == node.RESULT_TYPE_FOLDER &&
        !this._ls.isLivemark(node.itemId)) {
      node.QueryInterface(Ci.nsINavHistoryQueryResultNode);
      node.containerOpen = true;
      for (var i = 0; i < node.childCount; i++) {
        this._resetGUIDsInt(node.getChild(i));
      }
    }
  },

  /* Get the deltas/combined updates from the server
   * Returns:
   *   status:
   *     -1: error
   *      0: ok
   * These fields may be null when status is -1:
   *   formatVersion:
   *     version of the data format itself.  For compatibility checks.
   *   maxVersion:
   *     the latest version on the server
   *   snapVersion:
   *     the version of the current snapshot on the server (deltas not applied)
   *   snapshot:
   *     full snapshot of the latest server version (deltas applied)
   *   deltas:
   *     all of the individual deltas on the server
   *   updates:
   *     the relevant deltas (from our snapshot version to current),
   *     combined into a single set.
   */
  _getServerData: function BSS__getServerData(onComplete) {
    let cont = yield;

    let ret = {status: -1,
               formatVersion: null, maxVersion: null, snapVersion: null,
               snapshot: null, deltas: null, updates: null};

    this._log.info("Getting bookmarks status from server");
    this._dav.GET("bookmarks-status.json", cont);
    let statusResp = yield;

    switch (statusResp.target.status) {
    case 200:
      this._log.info("Got bookmarks status from server");

      let status = eval(statusResp.target.responseText);
      let snap, deltas, allDeltas;

      // Bail out if the server has a newer format version than we can parse
      if (status.formatVersion > STORAGE_FORMAT_VERSION) {
        this._log.error("Server uses storage format v" + status.formatVersion +
                  ", this client understands up to v" + STORAGE_FORMAT_VERSION);
        generatorDone(this, onComplete, ret)
        return;
      }

      if (status.GUID != this._snapshotGUID) {
        this._log.info("Remote/local sync GUIDs do not match.  " +
                    "Forcing initial sync.");
        this._resetGUIDs();
        this._snapshot = {};
        this._snapshotVersion = -1;
        this._snapshotGUID = status.GUID;
      }

      if (this._snapshotVersion < status.snapVersion) {
        if (this._snapshotVersion >= 0)
          this._log.info("Local snapshot is out of date");

        this._log.info("Downloading server snapshot");
        this._dav.GET("bookmarks-snapshot.json", cont);
        let snapResp = yield;
        if (snapResp.target.status < 200 || snapResp.target.status >= 300) {
          this._log.error("Could not download server snapshot");
          generatorDone(this, onComplete, ret)
          return;
        }
        snap = eval(snapResp.target.responseText);

        this._log.info("Downloading server deltas");
        this._dav.GET("bookmarks-deltas.json", cont);
        let deltasResp = yield;
        if (deltasResp.target.status < 200 || deltasResp.target.status >= 300) {
          this._log.error("Could not download server deltas");
          generatorDone(this, onComplete, ret)
          return;
        }
        allDeltas = eval(deltasResp.target.responseText);
        deltas = eval(uneval(allDeltas));

      } else if (this._snapshotVersion >= status.snapVersion &&
                 this._snapshotVersion < status.maxVersion) {
        snap = eval(uneval(this._snapshot));

        this._log.info("Downloading server deltas");
        this._dav.GET("bookmarks-deltas.json", cont);
        let deltasResp = yield;
        if (deltasResp.target.status < 200 || deltasResp.target.status >= 300) {
          this._log.error("Could not download server deltas");
          generatorDone(this, onComplete, ret)
          return;
        }
        allDeltas = eval(deltasResp.target.responseText);
        deltas = allDeltas.slice(this._snapshotVersion - status.snapVersion);

      } else if (this._snapshotVersion == status.maxVersion) {
        snap = eval(uneval(this._snapshot));

        // FIXME: could optimize this case by caching deltas file
        this._log.info("Downloading server deltas");
        this._dav.GET("bookmarks-deltas.json", cont);
        let deltasResp = yield;
        if (deltasResp.target.status < 200 || deltasResp.target.status >= 300) {
          this._log.error("Could not download server deltas");
          generatorDone(this, onComplete, ret)
          return;
        }
        allDeltas = eval(deltasResp.target.responseText);
        deltas = [];

      } else { // this._snapshotVersion > status.maxVersion
        this._log.error("Server snapshot is older than local snapshot");
        generatorDone(this, onComplete, ret)
        return;
      }

      for (var i = 0; i < deltas.length; i++) {
        snap = this._applyCommandsToObj(deltas[i], snap);
      }

      ret.status = 0;
      ret.formatVersion = status.formatVersion;
      ret.maxVersion = status.maxVersion;
      ret.snapVersion = status.snapVersion;
      ret.snapshot = snap;
      ret.deltas = allDeltas;
      ret.updates = this._detectUpdates(this._snapshot, snap);
      break;

    case 404:
      this._log.info("Server has no status file, Initial upload to server");

      this._snapshot = this._getBookmarks();
      this._snapshotVersion = 0;
      this._snapshotGUID = null; // in case there are other snapshots out there

      this._dav.PUT("bookmarks-snapshot.json",
                    this._mungeNodes(this._snapshot), cont);
      let snapPut = yield;
      if (snapPut.target.status < 200 || snapPut.target.status >= 300) {
        this._log.error("Could not upload snapshot to server, error code: " +
                    snapPut.target.status);
        generatorDone(this, onComplete, ret)
        return;
      }

      this._dav.PUT("bookmarks-deltas.json", uneval([]), cont);
      let deltasPut = yield;
      if (deltasPut.target.status < 200 || deltasPut.target.status >= 300) {
        this._log.error("Could not upload deltas to server, error code: " +
                   deltasPut.target.status);
        generatorDone(this, onComplete, ret)
        return;
      }

      this._dav.PUT("bookmarks-status.json",
                    uneval({GUID: this._snapshotGUID,
                            formatVersion: STORAGE_FORMAT_VERSION,
                            snapVersion: this._snapshotVersion,
                            maxVersion: this._snapshotVersion}), cont);
      let statusPut = yield;
      if (statusPut.target.status < 200 || statusPut.target.status >= 300) {
        this._log.error("Could not upload status file to server, error code: " +
                   statusPut.target.status);
        generatorDone(this, onComplete, ret)
        return;
      }

      this._log.info("Initial upload to server successful");
      this._saveSnapshot();

      ret.status = 0;
      ret.formatVersion = STORAGE_FORMAT_VERSION;
      ret.maxVersion = this._snapshotVersion;
      ret.snapVersion = this._snapshotVersion;
      ret.snapshot = eval(uneval(this._snapshot));
      ret.deltas = [];
      ret.updates = [];
      break;

    default:
      this._log.error("Could not get bookmarks.status: unknown HTTP status code " +
                      statusResp.target.status);
      break;
    }
    generatorDone(this, onComplete, ret)
  },

  _onLogin: function BSS__onLogin(success) {
    if (success) {
      this._log.info("Logged in");
      this._log.info("Bookmarks sync server: " + this._dav.baseURL);
      this._os.notifyObservers(null, "bookmarks-sync:login", "");
    } else {
      this._log.info("Could not log in");
      this._os.notifyObservers(null, "bookmarks-sync:login-error", "");
    }
  },

  _onResetLock: function BSS__resetLock(success) {
    if (success) {
      this._log.info("Lock reset");
      this._os.notifyObservers(null, "bookmarks-sync:lock-reset", "");
    } else {
      this._log.warn("Lock reset error");
      this._os.notifyObservers(null, "bookmarks-sync:lock-reset-error", "");
    }
  },

  // XPCOM registration
  classDescription: "Bookmarks Sync Service",
  contractID: "@mozilla.org/places/sync-service;1",
  classID: Components.ID("{efb3ba58-69bc-42d5-a430-0746fa4b1a7f}"),
  QueryInterface: XPCOMUtils.generateQI([Ci.IBookmarksSyncService,
                                         Ci.nsIObserver,
                                         Ci.nsISupports]),

  // nsISupports

  // nsIObserver

  observe: function BSS__observe(subject, topic, data) {
    switch (topic) {
    case "browser.places.sync.enabled":
      switch (data) {
      case false:
        this._log.info("Disabling automagic bookmarks sync");
        this._disableSchedule();
        break;
      case true:
        this._log.info("Enabling automagic bookmarks sync");
        this._enableSchedule();
        break;
      }
      break;
    case "browser.places.sync.schedule":
      switch (data) {
      case 0:
        this._log.info("Disabling automagic bookmarks sync");
        this._disableSchedule();
        break;
      case 1:
        this._log.info("Enabling automagic bookmarks sync");
        this._enableSchedule();
        break;
      default:
        this._log.warn("Unknown schedule value set");
        break;
      }
      break;
    default:
      // ignore, there are prefs we observe but don't care about
    }
  },

  // IBookmarksSyncService

  sync: function BSS_sync() {
    this._log.info("Beginning sync");
    this._os.notifyObservers(null, "bookmarks-sync:start", "");
    this._doSync.async(this);
  },

  login: function BSS_login() {
    this._log.info("Logging in");
    let callback = bind2(this, this._onLogin);
    if (!this._dav.login.async(this._dav, callback))
      this._os.notifyObservers(null, "bookmarks-sync:login-error", "");
  },

  logout: function BSS_logout() {
    this._log.info("Logging out");
    this._dav.logout();
    this._os.notifyObservers(null, "bookmarks-sync:logout", "");
  },

  resetLock: function BSS_resetLock() {
    this._log.info("Resetting lock");
    this._dav.forceUnlock.async(this._dav, bind2(this, this._onResetLock));
  }
};

function makeFile(path) {
  var file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
  file.initWithPath(path);
  return file;
}

function makeURI(URIString) {
  var ioservice = Cc["@mozilla.org/network/io-service;1"].
                  getService(Ci.nsIIOService);
  return ioservice.newURI(URIString, null, null);
}

function bind2(object, method) {
  return function innerBind() { return method.apply(object, arguments); }
}

Function.prototype.async = function(self, extra_args) {
  let args = Array.prototype.slice.call(arguments, 1);
  let ret = false;
  try {
    let gen = this.apply(self, args);
    gen.next(); // must initialize before sending
    gen.send(function(data) { continueGenerator(gen, data); });
    ret = true;
  } catch (e) {
    if (e instanceof StopIteration)
      dump("Warning: generator stopped unexpectedly");
    else
      throw e;
  }
  return ret;
}

function continueGenerator(generator, data) {
  try { generator.send(data); }
  catch (e) {
    if (e instanceof StopIteration)
      generator = null;
    else
      throw e;
  }
}

// generators called using Function.async can't simply call the
// callback with the return value, since that would cause the calling
// function to end up running (after the yield) from inside the
// generator.  Instead, generators can call this method which sets up
// a timer to call the callback from a timer (and cleans up the timer
// to avoid leaks).
function generatorDone(object, callback, retval) {
  if (object._timer)
    throw "Called generatorDone when there is a timer already set."

  let cb = bind2(object, function(event) {
    object._timer = null;
    callback(retval);
  });

  object._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  object._timer.initWithCallback(new EventListener(cb),
                                 0, object._timer.TYPE_ONE_SHOT);
}

function EventListener(handler) {
  this._handler = handler;
}
EventListener.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsITimerCallback, Ci.nsISupports]),

  // DOM event listener
  handleEvent: function EL_handleEvent(event) {
    this._handler(event);
  },

  // nsITimerCallback
  notify: function EL_notify(timer) {
    this._handler(timer);
  }
};

function xpath(xmlDoc, xpathString) {
  let root = xmlDoc.ownerDocument == null ?
    xmlDoc.documentElement : xmlDoc.ownerDocument.documentElement
  let nsResolver = xmlDoc.createNSResolver(root);

  return xmlDoc.evaluate(xpathString, xmlDoc, nsResolver,
                         Ci.nsIDOMXPathResult.ANY_TYPE, null);
}

function DAVCollection(baseURL) {
  this._baseURL = baseURL;
  this._authProvider = new DummyAuthProvider();
}
DAVCollection.prototype = {
  __dp: null,
  get _dp() {
    if (!this.__dp)
      this.__dp = Cc["@mozilla.org/xmlextras/domparser;1"].
        createInstance(Ci.nsIDOMParser);
    return this.__dp;
  },

  __base64: {},
  __vase64loaded: false,
  get _base64() {
    if (!this.__base64loaded) {
      let jsLoader = Cc["@mozilla.org/moz/jssubscript-loader;1"].
        getService(Ci.mozIJSSubScriptLoader);
      jsLoader.loadSubScript("chrome://sync/content/base64.js", this.__base64);
      this.__base64loaded = true;
    }
    return this.__base64;
  },

  // FIXME: should we regen this each time to prevent it from staying in memory?
  __auth: null,
  get _auth() {
    if (this.__auth)
      return this.__auth;

    try {
      let URI = makeURI(this._baseURL);
      let username = 'nobody@mozilla.com';
      let password;

      let branch = Cc["@mozilla.org/preferences-service;1"].
        getService(Ci.nsIPrefBranch);
      username = branch.getCharPref("browser.places.sync.username");

      if (!username)
        return null;

      // fixme: make a request and get the realm
      let lm = Cc["@mozilla.org/login-manager;1"].getService(Ci.nsILoginManager);
      let logins = lm.findLogins({}, URI.hostPort, null,
                                 'services.mozilla.com');

      for (let i = 0; i < logins.length; i++) {
        if (logins[i].username == username) {
          password = logins[i].password;
          break;
        }
      }

      if (!password)
        return null;

      this.__auth = "Basic " +
        this._base64.Base64.encode(username + ":" + password);

    } catch (e) {}

    return this.__auth;
  },

  get baseURL() {
    return this._baseURL;
  },

  _loggedIn: false,
  _currentUserPath: "nobody",

  _currentUser: "nobody@mozilla.com",
  get currentUser() {
    return this._currentUser;
  },

  _makeRequest: function DC__makeRequest(op, path, onComplete, headers) {
    var request = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance();
    request = request.QueryInterface(Ci.nsIDOMEventTarget);
  
    request.addEventListener("load", new EventListener(onComplete), false);
    request.addEventListener("error", new EventListener(onComplete), false);
    request = request.QueryInterface(Ci.nsIXMLHttpRequest);
    request.open(op, this._baseURL + path, true);
  
    if (headers) {
      for (var key in headers) {
        request.setRequestHeader(key, headers[key]);
      }
    }

    request.channel.notificationCallbacks = this._authProvider;

    return request;
  },

  GET: function DC_GET(path, onComplete, headers) {
    if (!headers)
      headers = {'Content-type': 'text/plain'};
    if (this._auth)
      headers['Authorization'] = this._auth;
    if (this._token)
      headers['If'] = "<" + this._bashURL + "> (<" + this._token + ">)";
    let request = this._makeRequest("GET", path, onComplete, headers);
    request.send(null);
  },

  PUT: function DC_PUT(path, data, onComplete, headers) {
    if (!headers)
      headers = {'Content-type': 'text/plain'};
    if (this._auth)
      headers['Authorization'] = this._auth;
    if (this._token)
      headers['If'] = "<" + this._bashURL + "> (<" + this._token + ">)";
    let request = this._makeRequest("PUT", path, onComplete, headers);
    request.send(data);
  },

  // Login / Logout

  login: function DC_login(onComplete) {
    let cont = yield;
    this._loggedIn = false;

    try {
      let headers = {};
      if (this._auth)
        headers['Authorization'] = this._auth;
   
      this._authProvider._authFailed = false;

      let request = this._makeRequest("GET", "", cont, headers);
      request.send(null);
      let event = yield;

      if (this._authProvider._authFailed || event.target.status >= 400)
        return;
  
      // XXX we need to refine some server response codes
      let branch = Cc["@mozilla.org/preferences-service;1"].
        getService(Ci.nsIPrefBranch);
      this._currentUser = branch.getCharPref("browser.places.sync.username");
  
      // XXX
      let path = this._currentUser.split("@");
      this._currentUserPath = path[0];
      this._baseURL = this._baseURL + this._currentUserPath + "/";
      this._loggedIn = true;

    } finally {
      generatorDone(this, onComplete, this._loggedIn);
    }
  },

  logout: function DC_logout() {
    this._loggedIn = false;
    this.__auth = null;
  },

  // Locking

  _getActiveLock: function DC__getActiveLock(onComplete) {
    let cont = yield;
    let ret = null;

    try {
      let headers = {'Content-Type': 'text/xml; charset="utf-8"',
                     'Depth': '0'};
      if (this._auth)
        headers['Authorization'] = this._auth;

      let request = this._makeRequest("PROPFIND", "", cont, headers);
      request.send("<?xml version=\"1.0\" encoding=\"utf-8\" ?>" +
                   "<D:propfind xmlns:D='DAV:'>" +
                   "  <D:prop><D:lockdiscovery/></D:prop>" +
                   "</D:propfind>");
      let event = yield;
      let tokens = xpath(event.target.responseXML, '//D:locktoken/D:href');
      let token = tokens.iterateNext();
      ret = token.textContent;
    } finally {
      generatorDone(this, onComplete, ret);
    }
  },

  lock: function DC_lock(onComplete) {
    let cont = yield;
    this._token = null;

    try {
      headers = {'Content-Type': 'text/xml; charset="utf-8"',
                 'Timeout': 'Second-600',
                 'Depth': 'infinity'};
      if (this._auth)
        headers['Authorization'] = this._auth;

      let request = this._makeRequest("LOCK", "", cont, headers);
      request.send("<?xml version=\"1.0\" encoding=\"utf-8\" ?>\n" +
                   "<D:lockinfo xmlns:D=\"DAV:\">\n" +
                   "  <D:locktype><D:write/></D:locktype>\n" +
                   "  <D:lockscope><D:exclusive/></D:lockscope>\n" +
                   "</D:lockinfo>");
      let event = yield;

      if (event.target.status < 200 || event.target.status >= 300)
        return;

      let tokens = xpath(event.target.responseXML, '//D:locktoken/D:href');
      let token = tokens.iterateNext();
      if (token)
        this._token = token.textContent;

    } finally {
      generatorDone(this, onComplete, this._token);
    }
  },

  unlock: function DC_unlock(onComplete) {
    let cont = yield;

    try {
      if (!this._token)
        return;

      let headers = {'Lock-Token': "<" + this._token + ">"};
      if (this._auth)
        headers['Authorization'] = this._auth;

      let request = this._makeRequest("UNLOCK", "", cont, headers);
      request.send(null);
      let event = yield;

      if (event.target.status < 200 || event.target.status >= 300)
        return;

      this._token = null;
    } finally {
      if (this._token)
        generatorDone(this, onComplete, false);
      else
        generatorDone(this, onComplete, true);
    }
  },

  forceUnlock: function DC_forceUnlock(onComplete) {
    let cont = yield;
    let unlocked = true;

    try {
      if (!this._getActiveLock.async(this, cont))
        return;
      this._token = yield;

      if (this._token) {
        if (!this.unlock.async(this, cont))
          return;
        unlocked = yield;
      }
    } finally {
      generatorDone(this, onComplete, unlocked);
    }
  },

  stealLock: function DC_stealLock(onComplete) {
    let cont = yield;
    let stolen = null;

    try {
      if (!this.forceUnlock.async(this, cont))
        return;
      let unlocked = yield;

      if (unlocked && this.lock.async(this, cont))
        stolen = yield;
    } finally {
      generatorDone(this, onComplete, stolen);
    }
  }
};


// Taken from nsMicrosummaryService.js and massaged slightly
function DummyAuthProvider() {}
DummyAuthProvider.prototype = {
  // Implement notification callback interfaces so we can suppress UI
  // and abort loads for bad SSL certs and HTTP authorization requests.
  
  // Interfaces this component implements.
  interfaces: [Ci.nsIBadCertListener,
               Ci.nsIAuthPromptProvider,
               Ci.nsIAuthPrompt,
               Ci.nsIPrompt,
               Ci.nsIProgressEventSink,
               Ci.nsIInterfaceRequestor,
               Ci.nsISupports],

  // Auth requests appear to succeed when we cancel them (since the server
  // redirects us to a "you're not authorized" page), so we have to set a flag
  // to let the load handler know to treat the load as a failure.
  get _authFailed()         { return this.__authFailed; },
  set _authFailed(newValue) { return this.__authFailed = newValue },

  // nsISupports

  QueryInterface: function DAP_QueryInterface(iid) {
    if (!this.interfaces.some( function(v) { return iid.equals(v) } ))
      throw Cr.NS_ERROR_NO_INTERFACE;

    // nsIAuthPrompt and nsIPrompt need separate implementations because
    // their method signatures conflict.  The other interfaces we implement
    // within DummyAuthProvider itself.
    switch(iid) {
    case Ci.nsIAuthPrompt:
      return this.authPrompt;
    case Ci.nsIPrompt:
      return this.prompt;
    default:
      return this;
    }
  },

  // nsIInterfaceRequestor
  
  getInterface: function DAP_getInterface(iid) {
    return this.QueryInterface(iid);
  },

  // nsIBadCertListener

  // Suppress UI and abort secure loads from servers with bad SSL certificates.
  
  confirmUnknownIssuer: function DAP_confirmUnknownIssuer(socketInfo, cert, certAddType) {
    return false;
  },

  confirmMismatchDomain: function DAP_confirmMismatchDomain(socketInfo, targetURL, cert) {
    return false;
  },

  confirmCertExpired: function DAP_confirmCertExpired(socketInfo, cert) {
    return false;
  },

  notifyCrlNextupdate: function DAP_notifyCrlNextupdate(socketInfo, targetURL, cert) {
  },

  // nsIAuthPromptProvider
  
  getAuthPrompt: function(aPromptReason, aIID) {
    this._authFailed = true;
    throw Cr.NS_ERROR_NOT_AVAILABLE;
  },

  // HTTP always requests nsIAuthPromptProvider first, so it never needs
  // nsIAuthPrompt, but not all channels use nsIAuthPromptProvider, so we
  // implement nsIAuthPrompt too.

  // nsIAuthPrompt

  get authPrompt() {
    var resource = this;
    return {
      QueryInterface: XPCOMUtils.generateQI([Ci.nsIPrompt]),
      prompt: function(dialogTitle, text, passwordRealm, savePassword, defaultText, result) {
        resource._authFailed = true;
        return false;
      },
      promptUsernameAndPassword: function(dialogTitle, text, passwordRealm, savePassword, user, pwd) {
        resource._authFailed = true;
        return false;
      },
      promptPassword: function(dialogTitle, text, passwordRealm, savePassword, pwd) {
        resource._authFailed = true;
        return false;
      }
    };
  },

  // nsIPrompt

  get prompt() {
    var resource = this;
    return {
      QueryInterface: XPCOMUtils.generateQI([Ci.nsIPrompt]),
      alert: function(dialogTitle, text) {
        throw Cr.NS_ERROR_NOT_IMPLEMENTED;
      },
      alertCheck: function(dialogTitle, text, checkMessage, checkValue) {
        throw Cr.NS_ERROR_NOT_IMPLEMENTED;
      },
      confirm: function(dialogTitle, text) {
        throw Cr.NS_ERROR_NOT_IMPLEMENTED;
      },
      confirmCheck: function(dialogTitle, text, checkMessage, checkValue) {
        throw Cr.NS_ERROR_NOT_IMPLEMENTED;
      },
      confirmEx: function(dialogTitle, text, buttonFlags, button0Title, button1Title, button2Title, checkMsg, checkValue) {
        throw Cr.NS_ERROR_NOT_IMPLEMENTED;
      },
      prompt: function(dialogTitle, text, value, checkMsg, checkValue) {
        throw Cr.NS_ERROR_NOT_IMPLEMENTED;
      },
      promptPassword: function(dialogTitle, text, password, checkMsg, checkValue) {
        resource._authFailed = true;
        return false;
      },
      promptUsernameAndPassword: function(dialogTitle, text, username, password, checkMsg, checkValue) {
        resource._authFailed = true;
        return false;
      },
      select: function(dialogTitle, text, count, selectList, outSelection) {
        throw Cr.NS_ERROR_NOT_IMPLEMENTED;
      }
    };
  },

  // nsIProgressEventSink

  onProgress: function DAP_onProgress(aRequest, aContext,
                                      aProgress, aProgressMax) {
  },

  onStatus: function DAP_onStatus(aRequest, aContext,
                                  aStatus, aStatusArg) {
  }
};

function NSGetModule(compMgr, fileSpec) {
  return XPCOMUtils.generateModule([BookmarksSyncService]);
}
