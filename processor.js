var ssbmsgs = require('ssb-msgs')
var EventEmitter = require('events').EventEmitter

var trustLinkOpts = { tofeed: true, rel: 'trusts' }
module.exports = function(sbot, state) {

  var events = new EventEmitter()
  var processors = {
    init: function (msg) {
      var profile = getProfile(msg.value.author)
      profile.createdAt = msg.value.timestamp      
    },

    name: function (msg) {
      var content = msg.value.content
      var author = msg.value.author
      if (empty(content.name))
        return
      var name = noSpaces(content.name)

      var links = ssbmsgs.getLinks(content, 'names')
      if (links.length) {
        links.forEach(function(link) {
          if (!link.feed)
            return

          // name assigned to other
          var target = getProfile(link.feed)
          target.assignedBy[author] = target.assignedBy[author] || {}
          target.assignedBy[author].name = name
          var source = getProfile(author)
          source.assignedTo[link.feed] = source.assignedTo[link.feed] || {}
          source.assignedTo[link.feed].name = name
          rebuildNamesFor(link.feed)
        })
      } else {
        // name assigned to self
        var profile = getProfile(author)
        profile.self.name = name
        rebuildNamesFor(author)          
      }
    },

    trust: function (msg) {
      var content = msg.value.content
      var author = msg.value.author

      // only process self-published trust edges for now
      if (author !== sbot.feed.id)
        return

      ssbmsgs.indexLinks(content, trustLinkOpts, function (link) {
        var profile = getProfile(link.feed)
        profile.trust = +link.value || 0
        if (profile.trust === 1) state.trustedProfiles[link.feed] = profile
        else                     delete state.trustedProfiles[link.feed]
        rebuildNamesBy(link.feed)
      })
    },

    post: function (msg) {
      var content = msg.value.content
      if (empty(content.text))
        return

      var isreply = false, isinboxed = false
      ssbmsgs.indexLinks(content, function(link) {
        if (link.rel == 'replies-to' && link.msg) {
          isreply = true

          // index thread
          if (!state.threads[link.msg]) {
            state.threads[link.msg] = { parent: null, replies: [], numThreadReplies: 0 }
            if (!contains(state.posts, link.msg)) {
              // index the parent as a post (it's a nonpost that now has replies, so is going to be treated as a post)
              // - use the reply's timestamp to insert. this saves us from looking up the message, and makes some sense
              sortedInsert(state.posts, msg.value.timestamp, link.msg)
            }
          }
          sortedInsert(state.threads[link.msg].replies, msg.value.timestamp, msg.key)
          state.threads[msg.key] = { parent: link.msg, replies: [], numThreadReplies: 0 }

          var t = state.threads[link.msg]
          do {
            t.numThreadReplies++
            t = state.threads[t.parent]
          } while (t)

          // add to inbox if it's a reply to this user's message
          if (!isinboxed && contains(state.myposts, link.msg)) {
            sortedInsert(state.inbox, msg.value.timestamp, msg.key)
            isinboxed = true
          }
        }
        else if (link.rel == 'mentions' && link.feed === sbot.feed.id && !isinboxed) {
          sortedInsert(state.inbox, msg.value.timestamp, msg.key)
          isinboxed = true
        }
      })

      if (!isreply && !contains(state.posts, msg.key)) {
        sortedInsert(state.posts, msg.value.timestamp, msg.key)
        events.emit('post', msg)
      }

      if (!state.postsByAuthor[msg.value.author])
        state.postsByAuthor[msg.value.author] = []
      sortedInsert(state.postsByAuthor[msg.value.author], msg.value.timestamp, msg.key)
    },

    advert: function(msg) {
      var content = msg.value.content
      if (empty(content.text))
        return

      sortedInsert(state.adverts, msg.value.timestamp, msg.key)
    }
  }

  function empty(str) {
    return !str || !(''+str).trim()
  }

  function getProfile(pid) {
    var profile = state.profiles[pid]
    if (!profile) {
      state.profiles[pid] = profile = {
        id: pid,
        self: { name: null },
        assignedBy: {},
        assignedTo: {},
        trust: 0,
        createdAt: null
      }
    }
    return profile
  }

  function rebuildNamesFor(pid) {
    var profile = getProfile(pid)

    // default to self-assigned name
    var name = profile.self.name
    var trust = 0
    if (pid === sbot.feed.id) {
      // is me, trust the self-assigned name
      trust = 1
    } else if (profile.assignedBy[sbot.feed.id] && profile.assignedBy[sbot.feed.id].name) {
      // use name assigned by me
      name = profile.assignedBy[sbot.feed.id].name
      trust = 1
    } else {
      // try to use a name assigned by someone trusted
      for (var id in profile.assignedBy) {
        if (profile.assignedBy[id].name && state.trustedProfiles[id]) {
          name = profile.assignedBy[id].name
          trust = 0.5
          break
        }
      }
    }

    // store
    state.names[pid] = name
    if (!state.ids[name])
      state.ids[name] = pid
    else {
      if (trust >= state.nameTrustRanks[state.ids[name]])
        state.ids[name] = pid
    }
    state.nameTrustRanks[pid] = trust
  }

  function rebuildNamesBy(pid) {
    var profile = getProfile(pid)
    for (var id in profile.assignedTo)
      rebuildNamesFor(id)
  }

  var spacesRgx = /\s/g
  function noSpaces (str) {
    return str.replace(spacesRgx, '_')
  }

  function sortedInsert(index, ts, key) {
    for (var i=0; i < index.length; i++) {
      if (index[i].ts < ts) {
        index.splice(i, 0, { ts: ts, key: key })
        return
      }
    }
    index.push({ ts: ts, key: key })
  }

  function contains(index, key) {
    for (var i=0; i < index.length; i++) {
      if (index[i].key === key)
        return true
    }    
  }

  // exported api

  function fn (logkey) {
    state.pinc()
    sbot.ssb.get(logkey.value, function (err, value) {
      var process = processors[value.content.type]
      if (process) {
        try { process({ key: logkey.value, value: value }) }
        catch (e) {
          // :TODO: use sbot logging plugin
          console.error('Failed to process message', e, logkey.value, value)
        }
      }
      state.pdec()
    })
  }
  fn.events = events

  return fn
}