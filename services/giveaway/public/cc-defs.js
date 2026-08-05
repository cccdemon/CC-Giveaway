/**
 * Chaos Crew – gemeinsame Protokoll-Definitionen (einzige Quelle im Repo).
 *
 * WS-Event- und gw_cmd-Whitelists für die Browser-Seiten. Wird von
 * giveaway-shared.js UND admin-shared.js gelesen (CC.defs) — die Datei liegt
 * beim giveaway-Service, weil der das WS-Protokoll besitzt, und wird über
 * Caddy als /giveaway/cc-defs.js auch von den admin-Seiten geladen.
 *
 * Ladereihenfolge: <script src="…cc-defs.js"> VOR der Shared-Lib. Fehlt die
 * Datei, blockiert validateWsPayload() alles (fail-closed) — siehe Shared-Libs.
 *
 * Neue Events/Cmds: NUR hier ergänzen. Phase 0 des Core-Umbaus
 * (docs/ARCHITEKTUR-CORES.md) hat die früheren Kopien in beiden Shared-Libs
 * zusammengeführt.
 */
(function(global) {
  'use strict';

  function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    Object.getOwnPropertyNames(obj).forEach(function(name) { deepFreeze(obj[name]); });
    return Object.freeze(obj);
  }

  var ALLOWED_EVENTS = [
    'gw_get_all', 'gw_cmd', 'gw_overlay', 'gw_join',
    'gw_ack', 'gw_data', 'gw_status', 'gw_keyword',
    'gw_multiplier', 'wt_update',
    'chat_msg', 'viewer_tick',
    'cc_identify',
    'ws:connect', 'ws:close', 'http:GET', 'http:POST', 'http:PUT', 'http:DELETE', 'http:PATCH'
  ];

  var ALLOWED_CMDS = [
    'gw_open', 'gw_close', 'gw_reset', 'gw_pause', 'gw_resume',
    'gw_draw_winner',
    'gw_add_ticket', 'gw_sub_ticket',
    'gw_ban', 'gw_unban',
    'gw_set_keyword', 'gw_get_keyword',
    'gw_set_multiplier', 'gw_get_multiplier',
    'gw_set_stream_settings', 'gw_get_stream_settings',
    'gw_get_ai_settings', 'gw_set_ai_settings', 'gw_test_ai', 'gw_rotate_ai_secret', 'gw_list_ai_models',
    'gw_get_channels', 'gw_verify_follows',
    'gw_gen_ingest_token', 'gw_get_ingest_tokens',
    'gw_open_instance', 'gw_close_instance', 'gw_list_giveaways',
    'gw_add_prize', 'gw_list_prizes', 'gw_set_wager_cmd',
    'gw_contest_voting', 'gw_review_entry', 'gw_list_entries'
  ];

  global.CC = global.CC || {};
  global.CC.defs = deepFreeze({
    ALLOWED_EVENTS: ALLOWED_EVENTS,
    ALLOWED_CMDS:   ALLOWED_CMDS
  });
})(window);
