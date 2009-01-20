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
 * The Original Code is Weave
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2008
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

const EXPORTED_SYMBOLS = ['HistoryEngine'];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

Cu.import("resource://weave/log4moz.js");
Cu.import("resource://weave/util.js");
Cu.import("resource://weave/engines.js");
Cu.import("resource://weave/stores.js");
Cu.import("resource://weave/trackers.js");
Cu.import("resource://weave/async.js");
Cu.import("resource://weave/type_records/history.js");

Function.prototype.async = Async.sugar;

function HistoryEngine() {
  this._init();
}
HistoryEngine.prototype = {
  __proto__: SyncEngine.prototype,
  name: "history",
  displayName: "History",
  logName: "History",
  _storeObj: HistoryStore,
  _trackerObj: HistoryTracker,

  // History reconciliation is simpler than the default one from SyncEngine,
  // because we have the advantage that we can use the URI as a definitive
  // check for local existence of incoming items.  The steps are as follows:
  // 
  // 1) Check for the same item in the locally modified list.  In that case,
  //    local trumps remote.  This step is unchanged from our superclass.
  // 2) Check if the incoming item was deleted.  Skip if so.
  // 3) Apply new record/update.
  // 
  // Note that we don't attempt to equalize the IDs, the history store does that
  // as part of update()
  _reconcile: function HistEngine__reconcile(item) {
    let self = yield;
    let ret = true;

    // Step 1: Check for conflicts
    //         If same as local record, do not upload
    if (item.id in this._tracker.changedIDs) {
      if (this._isEqual(item))
        this._tracker.removeChangedID(item.id);
      self.done(false);
      return;
    }

    // Step 2: Check if the item is deleted - we don't support that (yet?)
    if (item.cleartext == null) {
      self.done(false);
      return;
    }

    // Step 3: Apply update/new record
    self.done(true);
  }
};

function HistoryStore() {
  this._init();
}
HistoryStore.prototype = {
  __proto__: Store.prototype,
  _logName: "HistStore",

  get _hsvc() {
    let hsvc = Cc["@mozilla.org/browser/nav-history-service;1"].
      getService(Ci.nsINavHistoryService);
    hsvc.QueryInterface(Ci.nsIGlobalHistory2);
    hsvc.QueryInterface(Ci.nsIBrowserHistory);
    hsvc.QueryInterface(Ci.nsPIPlacesDatabase);
    this.__defineGetter__("_hsvc", function() hsvc);
    return hsvc;
  },

  get _anno() {
    let anno = Cc["@mozilla.org/browser/annotation-service;1"].
      getService(Ci.nsIAnnotationService);
    this.__defineGetter__("_ans", function() anno);
    return anno;
  },

  get _histDB_30() {
    let file = Cc["@mozilla.org/file/directory_service;1"].
      getService(Ci.nsIProperties).
      get("ProfD", Ci.nsIFile);
    file.append("places.sqlite");
    let stor = Cc["@mozilla.org/storage/service;1"].
      getService(Ci.mozIStorageService);
    let db = stor.openDatabase(file);
    this.__defineGetter__("_histDB_30", function() db);
    return db;
  },

  get _db() {
    return this._hsvc.DBConnection;
  },

  _fetchRow: function HistStore__fetchRow(stm, params, retparams) {
    try {
      for (let key in params) {
        stm.params[key] = params[key];
      }
      if (!stm.step())
        return null;
      if (retparams.length == 1)
        return stm.row[retparams[0]];
      let ret = {};
      for each (let key in retparams) {
        ret[key] = stm.row[key];
      }
      return ret;
    } finally {
      stm.reset();
    }
  },

  // Check for table existance manually because
  // mozIStorageConnection.tableExists() gives us false negatives
  tableExists: function HistStore__tableExists(tableName) {
    let statement = this._db.createStatement(
      "SELECT count(*) as count FROM sqlite_temp_master WHERE type='table' " +
      "AND name='" + tableName + "'");
    statement.step();
    let num = statement.row["count"];
    return num != 0;
  },

  get _visitStm() {
    this._log.trace("Creating SQL statement: _visitStm");
    let stm;
    if (this.tableExists("moz_historyvisits_temp")) {
      stm = this._db.createStatement(
        "SELECT * FROM ( " +
          "SELECT visit_type AS type, visit_date AS date " +
          "FROM moz_historyvisits_temp " +
          "WHERE place_id = :placeid " +
          "ORDER BY visit_date DESC " +
          "LIMIT 10 " +
        ") " +
        "UNION ALL " +
        "SELECT * FROM ( " +
          "SELECT visit_type AS type, visit_date AS date " +
          "FROM moz_historyvisits " +
          "WHERE place_id = :placeid " +
          "AND id NOT IN (SELECT id FROM moz_historyvisits_temp) " +
          "ORDER BY visit_date DESC " +
          "LIMIT 10 " +
        ") " +
        "ORDER BY 2 DESC LIMIT 10"); /* 2 is visit_date */
    } else {
      stm = this._db.createStatement(
	"SELECT visit_type AS type, visit_date AS date " +
	"FROM moz_historyvisits " +
	"WHERE place_id = :placeid " +
	"ORDER BY visit_date DESC LIMIT 10"
      );
    }
    this.__defineGetter__("_visitStm", function() stm);
    return stm;
  },

  get _pidStm() {
    this._log.trace("Creating SQL statement: _pidStm");
    let stm;
    // See comment in get _urlStm()
    if (this.tableExists("moz_places_temp")) {
      stm = this._db.createStatement(
        "SELECT * FROM " +
          "(SELECT id FROM moz_places_temp WHERE url = :url LIMIT 1) " +
        "UNION ALL " +
        "SELECT * FROM ( " +
          "SELECT id FROM moz_places WHERE url = :url " +
          "AND id NOT IN (SELECT id from moz_places_temp) " +
          "LIMIT 1 " +
        ") " +
        "LIMIT 1");
    } else {
      stm = this._db.createStatement(
	"SELECT id FROM moz_places WHERE url = :url LIMIT 1"
      );
    }
    this.__defineGetter__("_pidStm", function() stm);
    return stm;
  },

  get _urlStm() {
    this._log.trace("Creating SQL statement: _urlStm");
    /* On Fennec, there is no table called moz_places_temp.
     * (We think there should be; we're not sure why there's not.)
     * As a workaround until we figure out why, we'll check if the table
     * exists first, and if it doesn't we'll use a simpler query without
     * that table.
     */
    let stm;
    if (this.tableExists("moz_places_temp")) {
      stm = this._db.createStatement(
      "SELECT * FROM " +
        "(SELECT url,title FROM moz_places_temp WHERE id = :id LIMIT 1) " +
      "UNION ALL " +
      "SELECT * FROM ( " +
        "SELECT url,title FROM moz_places WHERE id = :id " +
        "AND id NOT IN (SELECT id from moz_places_temp) " +
        "LIMIT 1 " +
      ") " +
      "LIMIT 1");
    } else {
      stm = this._db.createStatement(
	"SELECT url,title FROM moz_places WHERE id = :id LIMIT 1"
      );
    }
    this.__defineGetter__("_urlStm", function() stm);
    return stm;
  },

  get _annoAttrIdStm() {
    this._log.trace("Creating SQL statement: _annoAttrIdStm");
    let stm = this._db.createStatement(
      "SELECT id from moz_anno_attributes WHERE name = :name");
    this.__defineGetter__("_annoAttrIdStm", function() stm);
    return stm;
  },

  get _findPidByAnnoStm() {
    this._log.trace("Creating SQL statement: _findPidByAnnoStm");
    let stm = this._db.createStatement(
      "SELECT place_id AS id FROM moz_annos " +
        "WHERE anno_attribute_id = :attr AND content = :content");
    this.__defineGetter__("_findPidByAnnoStm", function() stm);
    return stm;
  },

  // See bug 320831 for why we use SQL here
  _getVisits: function HistStore__getVisits(uri) {
    let visits = [];
    if (typeof(uri) != "string")
      uri = uri.spec;

    let placeid = this._fetchRow(this._pidStm, {url: uri}, ['id']);
    if (!placeid) {
      this._log.debug("Could not find place ID for history URL: " + placeid);
      return visits;
    }

    try {
      this._visitStm.params.placeid = placeid;
      while (this._visitStm.step()) {
        visits.push({date: this._visitStm.row.date,
                     type: this._visitStm.row.type});
      }
    } finally {
      this._visitStm.reset();
    }

    return visits;
  },

  _getGUID: function HistStore__getGUID(uri) {
    if (typeof(uri) == "string")
      uri = Utils.makeURI(uri);
    try {
      return this._anno.getPageAnnotation(uri, "weave/guid");
    } catch (e) {
      // FIXME
      // if (e != NS_ERROR_NOT_AVAILABLE)
      // throw e;
    }
    let guid = Utils.makeGUID();
    this._anno.setPageAnnotation(uri, "weave/guid", guid, 0, this._anno.EXPIRE_WITH_HISTORY);
    return guid;
  },

  // See bug 468732 for why we use SQL here
  _findURLByGUID: function HistStore__findURLByGUID(guid) {
    try {
      this._annoAttrIdStm.params.name = "weave/guid";
      if (!this._annoAttrIdStm.step())
        return null;
      let annoId = this._annoAttrIdStm.row.id;

      this._findPidByAnnoStm.params.attr = annoId;
      this._findPidByAnnoStm.params.content = guid;
      if (!this._findPidByAnnoStm.step())
        return null;
      let placeId = this._findPidByAnnoStm.row.id;

      this._urlStm.params.id = placeId;
      if (!this._urlStm.step())
        return null;

      return {url: this._urlStm.row.url,
              title: this._urlStm.row.title};
    } finally {
      this._annoAttrIdStm.reset();
      this._findPidByAnnoStm.reset();
      this._urlStm.reset();
    }
  },

  changeItemID: function HStore_changeItemID(oldID, newID) {
    try {
      let uri = Utils.makeURI(this._findURLByGUID(oldID).url);
      this._anno.setPageAnnotation(uri, "weave/guid", newID, 0, 0);
    } catch (e) {
      this._log.debug("Could not change item ID: " + e);
    }
  },


  getAllIDs: function HistStore_getAllIDs() {
    let query = this._hsvc.getNewQuery(),
        options = this._hsvc.getNewQueryOptions();

    query.minVisits = 1;
    options.maxResults = 100;
    options.sortingMode = options.SORT_BY_DATE_DESCENDING;
    options.queryType = options.QUERY_TYPE_HISTORY;

    let root = this._hsvc.executeQuery(query, options).root;
    root.QueryInterface(Ci.nsINavHistoryQueryResultNode);
    root.containerOpen = true;

    let items = {};
    for (let i = 0; i < root.childCount; i++) {
      let item = root.getChild(i);
      let guid = this._getGUID(item.uri);
      items[guid] = item.uri;
    }
    return items;
  },

  create: function HistStore_create(record) {
    this.update(record);
  },

  remove: function HistStore_remove(record) {
    //this._log.trace("  -> NOT removing history entry: " + record.id);
    // FIXME: implement!
  },

  update: function HistStore_update(record) {
    this._log.trace("  -> processing history entry: " + record.cleartext.uri);

    let uri = Utils.makeURI(record.cleartext.uri);
    let curvisits = [];
    if (this.urlExists(uri))
      curvisits = this._getVisits(record.cleartext.uri);

    let visit;
    while ((visit = record.cleartext.visits.pop())) {
      if (curvisits.filter(function(i) i.date == visit.date).length)
        continue;
      this._log.debug("     visit " + visit.date);
      this._hsvc.addVisit(uri, visit.date, null, visit.type,
                          (visit.type == 5 || visit.type == 6), 0);
    }
    this._hsvc.setPageTitle(uri, record.cleartext.title);

    // Equalize IDs 
    let localId = this._getGUID(record.cleartext.uri);
    if (localId != record.id)
      this.changeItemID(localId, record.id);

  },

  itemExists: function HistStore_itemExists(id) {
    if (this._findURLByGUID(id))
      return true;
    return false;
  },

  urlExists: function HistStore_urlExists(url) {
    if (typeof(url) == "string")
      url = Utils.makeURI(url);
    return this._hsvc.isVisited(url);
  },

  createRecord: function HistStore_createRecord(guid) {
    let foo = this._findURLByGUID(guid);
    let record = new HistoryRec();
    if (foo) {
      record.histUri = foo.url;
      record.title = foo.title;
      record.visits = this._getVisits(record.histUri);
    } else {
      record.cleartext = null; // deleted item
    }
    this.cache.put(guid, record);
    return record;
  },

  wipe: function HistStore_wipe() {
    this._hsvc.removeAllPages();
  }
};

function HistoryTracker() {
  this._init();
}
HistoryTracker.prototype = {
  __proto__: Tracker.prototype,
  _logName: "HistoryTracker",

  QueryInterface: XPCOMUtils.generateQI([Ci.nsINavHistoryObserver]),

  get _hsvc() {
    let hsvc = Cc["@mozilla.org/browser/nav-history-service;1"].
      getService(Ci.nsINavHistoryService);
    this.__defineGetter__("_hsvc", function() hsvc);
    return hsvc;
  },

  // FIXME: hack!
  get _store() {
    let store = new HistoryStore();
    this.__defineGetter__("_store", function() store);
    return store;
  },

  _init: function HT__init() {
    this.__proto__.__proto__._init.call(this);

    // FIXME: very roundabout way of getting url -> guid mapping!
    // FIXME2: not updated after startup
    let all = this._store.getAllIDs();
    this._all = {};
    for (let guid in all) {
      this._all[all[guid]] = guid;
    }

    this._hsvc.addObserver(this, false);
  },

  onBeginUpdateBatch: function HT_onBeginUpdateBatch() {},
  onEndUpdateBatch: function HT_onEndUpdateBatch() {},
  onPageChanged: function HT_onPageChanged() {},
  onTitleChanged: function HT_onTitleChanged() {},

  /* Every add or remove is worth 1 point.
   * Clearing the whole history is worth 50 points (see below)
   */
  _upScore: function BMT__upScore() {
    this._score += 1;
  },

  onVisit: function HT_onVisit(uri, vid, time, session, referrer, trans) {
    this._log.trace("onVisit: " + uri.spec);
    if (this.addChangedID(this._store._getGUID(uri)))
      this._upScore();
  },
  onPageExpired: function HT_onPageExpired(uri, time, entry) {
    this._log.trace("onPageExpired: " + uri.spec);
    if (this.addChangedID(this._store._getGUID(uri))) // XXX eek ?
      this._upScore();
  },
  onDeleteURI: function HT_onDeleteURI(uri) {
    this._log.trace("onDeleteURI: " + uri.spec);
    if (this.addChangedID(this._all[uri]))
      this._upScore();
  },
  onClearHistory: function HT_onClearHistory() {
    this._log.trace("onClearHistory");
    this._score += 50;
  }
};
