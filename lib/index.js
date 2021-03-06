var express = require('express')
  , Slack = require('slack-client')
  , Twilio = require('twilio')
  , _ = require('lodash')

module.exports = {

  // The user-specified options (set via this.configure)
  opts: {},

  // These are our "global" variables
  channel: undefined,
  slack: undefined,
  twilio: undefined,

  // Set options
  configure: function(opts) {
    this.opts = opts;
  },

  start: function() {
    var opts = this.opts;
    var self = this;

    if(!opts.channel) return console.error("[ERROR] You need to set OWLBOT_CHANNEL");
    if(!opts.slack.token || opts.slack.token.indexOf('#') >= 0) return console.error("[ERROR] You need to set OWLBOT_SLACK");
    if(!opts.twilio.phoneNumber || opts.slack.token.indexOf('#') >= 0) return console.error("[ERROR] You need to set OWLBOT_TWILIO_NUMBER");
    if(!opts.twilio.accountSid || opts.twilio.accountSid == "ABCDEF") return console.error("[ERROR] You need to set OWLBOT_TWILIO_ACCOUNTSID");
    if(!opts.twilio.authToken || opts.twilio.authToken == "12345") return console.error("[ERROR] You need to set OWLBOT_TWILIO_AUTHTOKEN");
    if(!opts.magic) return console.error("[ERROR] You need to set OWLBOT_MAGIC");

    // If the channel doesn't start with a #, add it.
    if(this.opts.channel.indexOf('#') != 0) {
      this.opts.channel = "#" + this.opts.channel;
    }

    // Set up Slack
    this.slack = new Slack(this.opts.slack.token, true, true);

    // Set up Twilio
    this.twilio = Twilio(this.opts.twilio.accountSid, this.opts.twilio.authToken);

    // Listen for slack connection
    this.slack.on('open', function() {
      var channel, id, messages;
      var channels = (function() {
        var ref, results;
        ref = self.slack.channels;
        results = [];
        for (id in ref) {
          channel = ref[id];
          if (channel.is_member) {
            results.push("#" + channel.name);
          }

          if(channel.name == self.opts.channel.replace(/#/, '')) {
            self.channel = channel;
          }
        }
        return results;
      })();

      if(!self.channel) {
        return console.error("ERROR: Your bot isn't in the specified channel (" + self.opts.channel + ")!");
      }

      console.log("Welcome to Slack. You are @" + self.slack.self.name + " of " + self.slack.team.name);
      console.log('  - You are in: ' + channels.join(', '));
    });

    // Slack listen for messages
    self.slack.on('message', function(message) {
      var channel, channelError, channelName, errors, response, text, textError, ts, type, typeError, user, userName;
      channel = self.slack.getChannelGroupOrDMByID(message.channel);
      user = self.slack.getUserByID(message.user);
      response = '';
      type = message.type, ts = message.ts, text = message.text;
      channelName = (channel != null ? channel.is_channel : void 0) ? '#' : '';
      channelName = channelName + (channel ? channel.name : 'UNKNOWN_CHANNEL');
      userName = (user != null ? user.name : void 0) != null ? "@" + user.name : "UNKNOWN_USER";

      function clean(text) {
        return text.replace(new RegExp("^" + userString + ":?\\s"), '');
      }

      if ((type === 'message') && (text != null) && (channel != null)) {

        var userString = '<@' + self.slack.self.id + '>';

        // Is it from the bot?
        if(message.user == self.slack.self.id) {
          return;
        }

        if(channelName == self.opts.channel && message.subtype == 'file_share') {
          // This is an image upload! (We use timeouts so they hopefully show up in order)
          self.handleSlackQuery(clean(message.file.title), channel);
          setTimeout(function() {
            self.handleSlackQuery(message.file.url, channel);
          }, 2000)
          if(message.file.initial_comment && message.file.initial_comment.comment) {
            setTimeout(function() {
              self.handleSlackQuery(clean(message.file.initial_comment.comment), channel);
            }, 4000)
          }
          return;
        } else if(channelName != self.opts.channel || message.subtype) {
          // We only want to send something if it's in the right channel.
          // (`message.subtype` indicates it's something like "John joined the channel", etc)
          var isDirectMessage = channelName.indexOf('#') != 0;
          var isRecipientOfMessage = text.indexOf('<@'+self.slack.self.id+'>') == 0;

          if(isDirectMessage || isRecipientOfMessage) {
            channel.send("Sorry, I can only respond in <#" + self.channel.id + ">!" );
          }
          return;
        }

        self.handleSlackQuery(clean(text), channel);
      } else {
        typeError = type !== 'message' ? "unexpected type " + type + "." : null;
        textError = text == null ? 'text was undefined.' : null;
        channelError = channel == null ? 'channel was undefined.' : null;
        errors = [typeError, textError, channelError].filter(function(element) {
          return element !== null;
        }).join(' ');
        return console.log("@" + self.slack.self.name + " could not respond. " + errors);
      }
    });

    // Slack error
    self.slack.on('error', function(error) {
      return console.error("Error: " + error);
    });

    // Set up our express server
    var app = express();
    var bodyParser = require('body-parser');
    app.use(bodyParser.urlencoded());
    app.use(bodyParser.json());

    // Wait for a post from Twilio
    app.post('/', function (req, res) {
      if (self.opts.bypassTwilioValidate || Twilio.validateExpressRequest(req, self.opts.twilio.authToken)) {
        if(req.body.Body) {
          var body = req.body.Body;

          if(req.body.MediaUrl0) {
            body += " " + req.body.MediaUrl0;
          }

          if(req.body.MediaUrl1) {
            body += " " + req.body.MediaUrl1;
          }

          console.log('[RECEIVED]', body);
          self.channel.send(body);
        }
        res.send("");
      } else {
        var msg = 'Not verified as being from Twilio! (You may want to turn on bypassTwilioValidate if you keep getting this.)';
        console.log('Error: ' + msg);
        res.send(msg);
      }
    });

    // Run the express server
    var server = app.listen(self.opts.port, function () {
      var host = server.address().address;
      var port = server.address().port;

      console.log('Slack bot is listening at http://%s:%s', host, port);
    });

    // Start the Slack connection
    self.slack.login();
  },

  // If we have a valid slack message to pass along
  handleSlackQuery: function(query, channel) {
    var self = this;

    // Don't send slack-specific emoji
    query = query.replace(/:simple_smile:/, ':)');
    query = query.replace(/:smile:/, ':D');
    query = query.replace(/:smiley:/, ':)');
    query = query.replace(/:wink:/, ';)');
    query = query.replace(/:stuck_out_tongue:/, ':P');
    query = query.replace(/:kiss:/, ':*');

    if(query.length > 770) { // 770 = 154 * 5
      channel.send("Hey chatterbox, keep it under 770 characters!");
      return;
    }

    if(query.length > 160) {
      var query_split = query.match(/.{1,154}/g);
      _.each(query_split, function(text, i) {
        setTimeout(function() {
          send("[" + (i+1) + "/" + query_split.length + "] " + text);
        }, 400 * i); // Try to space them out evenly
      });
    } else {
      send(query);
    }

    console.log('[SENT]', query);

    function send(text) {
      self.twilio.messages.create({
        body: text,
        to: self.opts.magic,
        from: self.opts.twilio.phoneNumber,
      }, function(err, message) {
        if(err) console.log(err);
      });
    }
  },

};
