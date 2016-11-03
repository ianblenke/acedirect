var express = require('express');
var io = require('socket.io');
var colors = require('colors');
var asteriskManager = require('asterisk-manager');
var nconf = require('nconf');
var util = require('util');
var ami = null;
var cfile = null;
var cio = require('socket.io-client');
var log4js = require('log4js');
var fs = require('fs');
var request = require('request');
var Map = require('collections/map');
var jwt = require('jsonwebtoken');
var bodyParser = require('body-parser');
var socketioJwt = require('socketio-jwt');
var fs = require('fs');
var ex;
var HashMap = require('hashmap');
var zendeskApi = require('node-zendesk');

// Contains login name => JSON data passed from browser
var statusMap = new HashMap();

// Contains the VRS number mapped to the Zendesk ticket number
var vrsToZenId = new HashMap();

// Contains the extension (e.g. 90001) mapped to {"secret":<password>, "inuse":true|false}
var consumerExtensions = new HashMap();

// Contains the extension (e.g. 90001) mapped to the VRS number (e.g. 7171234567)
var extensionToVrs = new HashMap();

// Maps extension (PJSIP/30001) to queue names {"queue_name":"GeneralQuestionssQueue", "queue2_name":"ComplaintsQueue"}
var extensionMap = new HashMap();

// Maps Linphone caller extension (6000x) to agent extension (3000x)
var linphoneToAgentMap = new HashMap();

// Maps consumer extension (6000x) to CSR extension (3000x)
var consumerToCsr = new HashMap();

// Initialize log4js
log4js.loadAppender('file');
var logname = 'ad-server';
log4js.configure({
    appenders: [
        {
            type: 'dateFile',
            filename: 'logs/' + logname + '.log',
            pattern: '-yyyy-MM-dd',
            alwaysIncludePattern: false,
            maxLogSize: 20480,
            backups: 10
        }
    ]
});

// Get the name of the config file from the command line (optional)
nconf.argv().env();

cfile = 'config.json';

// Validate the incoming JSCON config file
try {
    var content = fs.readFileSync(cfile, 'utf8');
    var myjson = JSON.parse(content);
    console.log("Valid JSON config file");
} catch (ex) {
    console.log("Error in " + cfile);
    console.log('Exiting...');
    console.log(ex);
    process.exit(1);
}

var logger = log4js.getLogger(logname);

nconf.file({file: cfile});
var configobj = JSON.parse(fs.readFileSync(cfile, 'utf8'));

// Set log4js level from the config file
logger.setLevel(nconf.get('debuglevel')); //log level hierarchy: ALL TRACE DEBUG INFO WARN ERROR FATAL OFF
logger.trace('TRACE messages enabled.');
logger.debug('DEBUG messages enabled.');
logger.info('INFO messages enabled.');
logger.warn('WARN messages enabled.');
logger.error('ERROR messages enabled.');
logger.fatal('FATAL messages enabled.');
logger.info('Using config file: ' + cfile);

// var dialaroundnums = nconf.get('dialaroundnums');

// Load the Zendesk login parameters
var zenUrl = nconf.get('zendesk:apiurl');
var zenUserId = nconf.get('zendesk:userid');
var zenToken = nconf.get('zendesk:token');

logger.info('Zendesk config:');
logger.info('URL: ' + zenUrl);
logger.info('UserID: ' + zenUserId);
logger.info('Token: ' + zenToken);
        
// Instantiate a connection to Zendesk
var zendeskClient = zendeskApi.createClient({
  username:  zenUserId,
  token:     zenToken,
  remoteUri: zenUrl
});

var app = express();
app.use(express.static(__dirname + '/'));
app.use(bodyParser.urlencoded({'extended': 'true'})); // parse application/x-www-form-urlencoded
app.use(bodyParser.json()); // parse application/json
app.use(bodyParser.json({type: 'application/vnd.api+json'})); // parse application/vnd.api+json as json

app.get('', function (req, res) {
  res.send('Hello from the agent portal') 
})


var server = app.listen(nconf.get('http:adport'));
io = io.listen(server);

//Validates the token, if valid go to connection.
//if token is not valid, no connection will be established.
io.use(socketioJwt.authorize({
    secret: Buffer(nconf.get('jsonwebtoken:secretkey'), nconf.get('jsonwebtoken:encoding')),
    timeout: nconf.get('jsonwebtoken:timeout'), // seconds to send the authentication message
    handshake: nconf.get('jsonwebtoken:handshake')
}));

console.log('Config file: ' + cfile);
logger.info('Config file: ' + cfile);

console.log('Server up and listening on port ' + nconf.get('http:adport'));
logger.info('Server up and listening on port ' + nconf.get('http:adport'));

// Note - socket only valid in this block
io.sockets.on('connection', function (socket) {
    
    // We will see this on connect or browser refresh
    logger.info('NEW CONNECTION');
    logger.info(socket.request.connection._peername);

    var token = socket.decoded_token;
    logger.info('connected & authenticated: ' + token.username + " - " + token.first_name + " " + token.last_name);
    logger.info("ExpiresIn:   " + (token.exp - token.iat) + " seconds");

    // Handle incoming Socket.IO registration requests - add to the room
    socket.on('register-client', function (data) {
        logger.info("Adding client socket to room:");
        logger.info(socket.id);
        logger.info(socket.request.connection._peername);

        // Add this socket to the room
        socket.join('my room');
    });
    
    // Handle incoming Socket.IO registration requests - add to the room
    socket.on('register-agent', function (data) {
        logger.info("Adding agent socket to room named: " + token.extension);
        logger.info(socket.id);
        logger.info(socket.request.connection._peername);

        // Add this socket to the room
        socket.join(token.extension);
        
        // var scriptData = getAllScripts();
        
        var url = nconf.get('scriptservice:url') + ":" + nconf.get('scriptservice:port');
		var assistanceurl = nconf.get('managementportal:assistance');
		if (assistanceurl === null) {
			logger.error("ERROR: assistance URL is null");
			assistanceurl = "";
		} else {
			logger.info("Assistance URL: " + assistanceurl);
		}
        var returnJson = {"message":"failed"};

        if (url) {
            url += '/getallscripts/';

            request({
                url: url,
                json: true
            }, function (error, response, data) {
                if (error) {
                    logger.error("ERROR: " + error);
                    data = {"message": "failed"};
					data.assistance = assistanceurl;
                    io.to(token.extension).emit('script-data', data);
                }
                // if(!error && response.statusCode === 200){
                else {
                    // logger.info("getAllScripts lookup response: " + data.message + JSON.stringify(data));
                    // console.log("getAllScripts lookup response: " + data.message + JSON.stringify(data));
					data.assistance = assistanceurl;
                    io.to(token.extension).emit('script-data', data);
                }
            });                   
        }    
    });

    /*
     * Handler catches a Socket.IO message to pause both queues.  Note, we are
     * pausing both queues, but, the extension is the same for both.
     */  
    socket.on('pause-queues', function () {        

        // Pause the first queue
        if (token.queue_name) {
            logger.info('PAUSING QUEUE: PJSIP/' + token.extension + ', queue name ' + token.queue_name);
            
            ami.action({
                "Action": "QueuePause",
                "ActionId": "1000",
                "Interface": "PJSIP/" + token.extension,
                "Paused": "true",
                "Queue": token.queue_name,
                "Reason": "QueuePause in pause-queue event handler"
            }, function (err, res) {});
        }
        
        // Pause the second queue (if not null)
        if (token.queue2_name) {
            logger.info('PAUSING QUEUE: PJSIP/' + token.extension + ', queue name ' + token.queue2_name);
            
            ami.action({
                "Action": "QueuePause",
                "ActionId": "1000",
                "Interface": "PJSIP/" + token.extension,
                "Paused": "true",
                "Queue": token.queue2_name,
                "Reason": "QueuePause in pause-queue event handler"
            }, function (err, res) {});
        }
        
    });

    socket.on('ready', function () {
        logger.info('State: READY - ' + token.username);
        statusMap.set(token.username, "READY");		
    });

    socket.on('away', function () {
        logger.info('State: AWAY - ' + token.username);
        statusMap.set(token.username, "AWAY");
    });

    /*
     * Handler catches a Socket.IO message to pause both queues.  Note, we are
     * unpausing both queues, but, the extension is the same for both.
     */  
    socket.on('unpause-queues', function () {

        if (token.queue_name) {
            logger.info('UNPAUSING QUEUE: PJSIP/' + token.extension + ', queue name ' + token.queue_name);
            
            ami.action({
                "Action": "QueuePause",
                "ActionId": "1000",
                "Interface": "PJSIP/" + token.extension,
                "Paused": "false",
                "Queue": token.queue_name,
                "Reason": "QueuePause in pause-queue event handler"
            }, function (err, res) {});
        }
        
        if (token.queue2_name) {
            logger.info('UNPAUSING QUEUE: PJSIP/' + token.extension + ', queue name ' + token.queue2_name);
            
            ami.action({
                "Action": "QueuePause",
                "ActionId": "1000",
                "Interface": "PJSIP/" + token.extension,
                "Paused": "false",
                "Queue": token.queue2_name,
                "Reason": "QueuePause in pause-queue event handler"
            }, function (err, res) {});
        }
    });

    // Send the call-ended message
    socket.on('call-ended', function (data) {
        io.to('my room').emit('ad-call-ended', data);
        logger.info('Sending ad-call-ended event');
    });

    // Handler catches a Socket.IO disconnect
    socket.on('disconnect', function () {
        logger.info('DISCONNECTED');
        logger.info(socket.id);
        logger.info(socket.request.connection._peername);

        //Removes user from statusMap
        if ("username" in token) {
            console.log("disconnecting...");
            logout(token);
        }
    });

    // ######################################################
    // All Socket.IO events below are ACD-specific
  
    /*
     *  Flow from consumer portal
     *  1. Consumer provides VRS #, email, complaint, sends to node server.
     *  2. Node server does a VRS lookup, creates a Zendesk ticket, then
     *     returns VRS data and Zendesk ticket number.
     */
    
    // Create a Zendesk ticket based on incoming info.
    socket.on('ad-ticket', function (data) {
        logger.info('Received a Zendesk ticket request: ' + JSON.stringify(data));      
        logger.info('Session Token: ' + JSON.stringify(token));
          
        processConsumerRequest(data);
    });
	
    // Update a Zendesk ticket based on incoming info. This is a CSR function.
    socket.on('modify-ticket', function (data) {
        logger.info('Received a Zendesk UPDATE ticket request: ' + JSON.stringify(data));      
        logger.info('Session Token: ' + JSON.stringify(token));
          
        updateZendeskTicket(data);
    });	
	
    // Handle incoming Socket.IO registration vrs requests 
    socket.on('register-vrs', function (data) {
        
        if(token.vrs){
            // logger.info("chat: register-vrs - if() case " + token.vrs);
            socket.join(Number(token.vrs));
        }
        else{
            // logger.info("chat: register-vrs - else() case " + data.vrs);
            socket.join(Number(data.vrs));
        }
    });
	
    //TODO: Leave room

    // Sends and Receives Chat Messages
    socket.on('chat-message', function(data) {	
        var vrs = null;
	var msg = data.message;

        //prevent vrs consumer from spoofing a vrs
        if(token.vrs){
            // logger.info("chat: chat-message - if() case " + token.vrs);
            vrs = token.vrs;
        }
        else{
            // logger.info("chat: chat-message - else() case " + data.vrs);
            vrs = data.vrs;
        }
	
	//Replace html tags with character entity code
	msg = msg.replace(/\</g,"&lt;")  
	msg = msg.replace(/\>/g,"&gt;")   
	data.message = msg; 
	
        // logger.info('chat: chat-message Number(vrs): ' + Number(vrs));
        io.to(Number(vrs)).emit('chat-message-new', data);
    });
	
	// Sends user is rtt message
    socket.on('chat-typing', function(data) {
        var vrs = null;
        var msg = data.rttmsg;
        if(token.vrs){
            // logger.info("chat: chat-typing - if() case " + token.vrs);
            vrs = token.vrs;
        }else{
            // logger.info("chat: chat-typing - else() case " + data.vrs);
            vrs = data.vrs;
        }
        // logger.info('chat: chat-typing Number(vrs): ' + Number(vrs));
        //Replace html tags with character entity code
        msg = msg.replace(/\</g,"&lt;")
        msg = msg.replace(/\>/g,"&gt;")
        io.to(Number(vrs)).emit('typing', {"typingmessage": data.displayname +' is typing...', "displayname": data.displayname, "rttmsg": msg});
    });

    
    // Chat clears user is typing message
    socket.on('chat-typing-clear', function(data) {
        var vrs = null;		
        if(token.vrs){
            // logger.info("chat: chat-typing-clear - if() case " + token.vrs);
            vrs = token.vrs;
        }
        else{
            // logger.info("chat: chat-typing-clear - else() case " + data.vrs);
            vrs = data.vrs;
        }
        
        // logger.info('chat: chat-typing-clear Number(vrs): ' + Number(vrs));
        io.to(Number(vrs)).emit('typing-clear', {"displayname": data.displayname});
    });    
    
    // chat-leave-ack
    socket.on('chat-leave-ack', function(data) {        
        // logger.info('Received chat-leave-ack' + JSON.stringify(data));
        
        if (data.vrs) {        
            // Dealing with a WebRTC consumer, otherwise, it is a Linphone
            socket.leave(Number(data.vrs));
        }
        
    });    
    
    // Agent sends the user-provded VRS number
    socket.on('input-vrs', function(data) {        
        
        logger.info('Received input-vrs ' + JSON.stringify(data) + ', calling vrsAndZenLookup() ');
        
        extensionToVrs.set(Number(data.extension), Number(data.vrs));
        
        vrsAndZenLookup(Number(data.vrs), Number(data.extension));
    });    

});

/*
 * Event handler to catch the incoming AMI action response.  Note, this is
 * a response to an AMI action (request from this node server) and is NOT
 * an Asterisk auto-generated event.
 */
function handle_action_response(evt) {
    // logger.info('\n######################################');
    // logger.info('Received an AMI action response: ' + evt);
    // logger.info(util.inspect(evt, false, null));
}

/*
 * Event handler to catch the incoming AMI events.  Note, these are the
 * events that are auto-generated by Asterisk (don't require any AMI actions
 * sent by this node server).
 */
function handle_manager_event(evt) {

    if (evt.event === 'DialEnd' || evt.event === 'Hangup' || evt.event === 'PeerStatus') {

        logger.info('\n######################################');
        logger.info('Received an AMI event: ' + evt.event);
        logger.info(util.inspect(evt, false, null));

        switch (evt.event) {

            /*
            case('PeerStatus'):
                
                if (evt.peerstatus === 'Unreachable') {
                    
                    logger.info('###### ASTERISK STUCK #####');
                    
                    // Should be something like PJSIP/30001                
                    var peer = evt.peer;
                    
                    if (extensionMap.has(peer)) {
                        var queueJson = extensionMap.get(peer);

                        if (queueJson.queue_name) {
                           logger.info('REMOVING QUEUE: ' + peer + ', queue name ' + queueJson.queue_name);

                            ami.action({
                                "Action": "QueueRemove",
                                "Interface": peer,
                                "Paused": "true",
                                "Queue": queueJson.queue_name
                            }, function (err, res) {});
                        }
            
                        if (queueJson.queue2_name) {
                            logger.info('REMOVING QUEUE: ' + peer + ', queue name ' + queueJson.queue2_name);

                            ami.action({
                                "Action": "QueueRemove",
                                "Interface": peer,
                                "Paused": "true",
                                "Queue": queueJson.queue2_name
                            }, function (err, res) {});
                        }

                        if (queueJson.queue_name) {
                           logger.info('ADDING QUEUE: ' + peer + ', queue name ' + queueJson.queue_name);
                    
                            ami.action({
                                "Action": "QueueAdd",
                                "Interface": peer,
                                "Paused": "false",
                                "Queue": queueJson.queue_name
                            }, function (err, res) {});
                        }

                        if (queueJson.queue2_name) {
                            logger.info('ADDING QUEUE: ' + peer + ', queue name ' + queueJson.queue2_name);
                            ami.action({
                                "Action": "QueueAdd",
                                "Interface": peer,
                                "Paused": "false",
                                "Queue": queueJson.queue2_name
                            }, function (err, res) {});
                        }
                    }
                }
            
            break;
            */

            // Sent by Asterisk when the call is answered
            case ('DialEnd'):
                
                // Make sure this is an ANSWER event only
                if (evt.dialstatus === 'ANSWER') {
                    
                    /*
                    *  For the complaints queue, we do the following:                  *  
                    *  - Get the extension number (channel field?)
                    *  - Look up the corresponding VRS (extensionToVrs map)
                    *  - Do a VRS lookup
                    *  - Use the extension and VRS to find the corresponding Zendesk ticket (zenIdToExtensionData map)
                    */                
                    if (evt.context === 'Complaints' || evt.context === 'Provider_Complaints') {
                        // Case #5
                                                
                        logger.info('DialEnd processing from a Complaints queue call');

                        // Format is PJSIP/90001-xxxxxx, we want to strip out the 90001 only
                        var extString = evt.channel;
                        var extension = extString.split(/[\/,-]/);
                        
                        if (extension[1] === 'ZVRS') {
                            extension[1] = evt.calleridnum;                            
                            logger.info('Matched on ZVRS, setting extension[1] to ' + evt.calleridnum);
                        }

                        var destExtString = evt.destchannel;
                        var destExtension = destExtString.split(/[\/,-]/);
                        
                        if (evt.context === 'Provider_Complaints') {
                            consumerToCsr.set(Number(extension[1]), Number(destExtension[1]));                            
                            logger.info('Populating consumerToCsr: ' + extension[1] + ' => ' + destExtension[1]);
                        }

                        logger.info('Extension number: ' + extension[1]);
                        logger.info('Dest extension number: ' + destExtension[1]);

                        var vrsNum = extensionToVrs.get(Number(extension[1]) );

                        if (vrsNum) {                    
                            // Call new function
                            logger.info('Calling vrsAndZenLookup with ' + vrsNum + ' and ' + destExtension[1]);
                            vrsAndZenLookup(Number(vrsNum), Number(destExtension[1]));
                        }
                        else {
                            // Trigger to agent to indicate that we don't have a valid VRS, agent will prompt user for VRS
                            io.to(Number(destExtension[1])).emit('missing-vrs', {});
                        } 

                        //tell CSR portal that a complaints queue call has connected
                        io.to(Number(destExtension[1])).emit('new-caller-complaints', {});
                    }
                    
                    if (evt.context === 'Provider_General_Questions') {
                        // Case #4
                        
                        /*
                        *  For the general questions queue, we do the following:                  *  
                        *  - Get the extension number (destchannel field?)
                        *  - Create an entry in the linphoneToAgentMap (linphone extension => dest agent extension)
                        *  - Emit a missing-vrs message to the correct agent portal (we don't have VRS for the Linphone caller)
                        *  - Emit a new-caller-general to the correct agent portal
                        */

                        logger.info('DialEnd processing from a Provider_General_Questions queue call');                                        
                        var agentString = evt.destchannel;
                        var agentExtension = agentString.split(/[\/,-]/);

                        var linphoneString = evt.channel;
                        var linphoneExtension = linphoneString.split(/[\/,-]/);

                        linphoneToAgentMap.set(Number(linphoneExtension[1]), Number(agentExtension[1]));

                        logger.info('Sending new-caller-general to agent: ' + agentExtension[1]);                                        

                        // Trigger to agent to indicate that we don't have a valid VRS, agent will prompt user for VRS
                        io.to(Number(agentExtension[1])).emit('missing-vrs', {});
                        io.to(Number(agentExtension[1])).emit('new-caller-general', {});
                    }
                }

                break;

            // Sent by Asterisk when the caller hangs up
            case ('Hangup'):
                
                
                // TODO use Hangup as a trigger to free set the "inuse" field in the consumerExtension field to false
                // channel: 'PJSIP/30001-0000002d',
                
                if (evt.context === 'Complaints') {
                    // Extension #5
                    
                    logger.info('Processing Hangup from a Complaints queue call');
                
                    var extString = evt.channel;
                    var extension = extString.split(/[\/,-]/);
                    
                    if (extension[1] === 'ZVRS') {
                        extension[1] = evt.calleridnum;          
                        logger.info('Matched on ZVRS, setting extension[1] to ' + evt.calleridnum);
                    }

                    logger.info('Hangup extension number: ' + extension[1]);

                    /*
                    logger.info('Map before:');
                    var keys = consumerExtensions.keys();
                    for (var i = 0; i < keys.length; i++ ) {
                        logger.info(keys[i] + ' => ' + JSON.stringify(consumerExtensions.get(keys[i])) );
                    }
                    */

                    if (consumerExtensions.has( Number(extension[1])) ) {
                        var val = consumerExtensions.get(Number(extension[1]));                                                            
                        val.inuse = false;

                        consumerExtensions.set(Number(extension[1]), val);
                    }
                    
                    /*
                    logger.info('After setting extension ' + extension[1] + ' inuse to false, the map contains:');
                    keys = consumerExtensions.keys();

                    logger.info('Map after:');
                    for (var i = 0; i < keys.length; i++ ) {
                        logger.info(keys[i] + ' => ' + JSON.stringify(consumerExtensions.get(keys[i])) );
                    }
                    */    
                   
                    logger.info('extensionToVrs contents:');
                    var keys = extensionToVrs.keys();

                    for (var i = 0; i < keys.length; i++ ) {
                        logger.info(keys[i] + ' => ' + JSON.stringify(extensionToVrs.get(keys[i])) );
                    }

                    
                    if (extensionToVrs.has(Number(extension[1]) ) ) {
                        logger.info('extensionToVrsMap contains ' + extension[1]);
                    }
                    else {
                        logger.info('extensionToVrsMap does not contain ' + extension[1]);
                    }
                    
                    
                    // chat-leave                    
                    var vrsNum = extensionToVrs.get(Number(extension[1]) );
                    
                    if (vrsNum) {
                        logger.info('Sending chat-leave for socket id ' + vrsNum);
                        io.to(Number(vrsNum)).emit('chat-leave', {"vrs":vrsNum});
                        
                        // Remove the extension when we're finished
                        extensionToVrs.remove(Number(extension[1]) );
                    }
                    else {
                        logger.error("Couldn't find VRS number in extensionToVrs map for extension " + extension[1]);
                    }
                }
                else if (evt.context === 'Provider_Complaints') {
                    // Extension #5
                    
                    logger.info('Processing Hangup from a Provider_Complaints queue call');
                
                    var extString = evt.channel;
                    var extension = extString.split(/[\/,-]/);
                    
                    if (extension[1] === 'ZVRS') {
                        extension[1] = evt.calleridnum;          
                        logger.info('Matched on ZVRS, setting extension[1] to ' + evt.calleridnum);
                    }

                    logger.info('Hangup extension number: ' + extension[1]);
                    
                    var csrExtension = 0;
                    if (consumerToCsr.has(Number(extension[1])) ) {
                        csrExtension = consumerToCsr.get(Number(extension[1]));
                        logger.info('Found CSR extension: ' + extension[1] + ' => ' + csrExtension);
                    }

                    /*
                    logger.info('Map before:');
                    var keys = consumerExtensions.keys();
                    for (var i = 0; i < keys.length; i++ ) {
                        logger.info(keys[i] + ' => ' + JSON.stringify(consumerExtensions.get(keys[i])) );
                    }
                    */

                    if (consumerExtensions.has( Number(csrExtension)) ) {
                        var val = consumerExtensions.get(Number(csrExtension));                                                            
                        val.inuse = false;

                        consumerExtensions.set(Number(csrExtension), val);
                    }
                    
                    /*
                    logger.info('After setting extension ' + extension[1] + ' inuse to false, the map contains:');
                    keys = consumerExtensions.keys();

                    logger.info('Map after:');
                    for (var i = 0; i < keys.length; i++ ) {
                        logger.info(keys[i] + ' => ' + JSON.stringify(consumerExtensions.get(keys[i])) );
                    }
                    */    
                   
                    logger.info('extensionToVrs contents:');
                    var keys = extensionToVrs.keys();

                    for (var i = 0; i < keys.length; i++ ) {
                        logger.info(keys[i] + ' => ' + JSON.stringify(extensionToVrs.get(keys[i])) );
                    }

                    
                    if (extensionToVrs.has(Number(csrExtension) ) ) {
                        logger.info('extensionToVrsMap contains ' + csrExtension);
                    }
                    else {
                        logger.info('extensionToVrsMap does not contain ' + csrExtension);
                    }
                    
                    
                    // chat-leave                    
                    var vrsNum = extensionToVrs.get(Number(csrExtension) );
                    
                    if (vrsNum) {
                        logger.info('Sending chat-leave for socket id ' + vrsNum);
                        io.to(Number(vrsNum)).emit('chat-leave', {"vrs":vrsNum});
                        
                        // Remove the extension when we're finished
                        extensionToVrs.remove(Number(csrExtension) );
                        
                        if (consumerToCsr.has(Number(extension[1])) ) {
                            consumerToCsr.remove(Number(extension[1]) );                            
                        }
                    }
                    else {
                        logger.error("Couldn't find VRS number in extensionToVrs map for extension " + csrExtension);
                    }
                }

                else if (evt.context === 'Provider_General_Questions') {
                    // Extension #4

                    var linphoneString = evt.channel;
                    var linphoneExtension = linphoneString.split(/[\/,-]/);  
                    
                    logger.info('Processing Hangup for a Provider_General_Questions queue call');
                    logger.info('Linphone extension number: ' + linphoneExtension[1]);

                    var agentExtension = 0;
                    
                    if (linphoneToAgentMap.has(Number(linphoneExtension[1]))) {
                        agentExtension = linphoneToAgentMap.get(Number(linphoneExtension[1]));
                        logger.info('Sending chat leave to agent extension: ' + agentExtension);
                        io.to(Number(agentExtension)).emit('chat-leave', {"extension":agentExtension});
                        
                        // Remove the entry
                        linphoneToAgentMap.remove(Number(linphoneExtension[1]));
                    }
                }

                break;

            default:
                // TODO - Exlude any AMI events we don't need
                logger.warn('AMI unhandled event: ' + evt.event);
                break;
        }
    }
}

/**
 * Instantiate the Asterisk connection.
 * @returns {undefined}
 */
function init_ami() {

    console.log('Entering init_ami()');
    
    if (ami === null) {
        
        logger.info('Asterisk connection:');
        logger.info('Asterisk port: ' + nconf.get('asteriskAD:ami:port') );
        logger.info('Asterisk host: ' + nconf.get('asteriskAD:sip:host') );
        logger.info('Asterisk id: ' + nconf.get('asteriskAD:ami:id') );
        logger.info('Asterisk password: ' + nconf.get('asteriskAD:ami:passwd') );
        
        console.log('Asterisk connection:');
        console.log('Asterisk port: ' + nconf.get('asteriskAD:ami:port') );
        console.log('Asterisk host: ' + nconf.get('asteriskAD:sip:host') );
        console.log('Asterisk id: ' + nconf.get('asteriskAD:ami:id') );
        console.log('Asterisk password: ' + nconf.get('asteriskAD:ami:passwd') );

        try {
            ami = new asteriskManager(nconf.get('asteriskAD:ami:port'),
                nconf.get('asteriskAD:sip:host'),
                nconf.get('asteriskAD:ami:id'),
                nconf.get('asteriskAD:ami:passwd'), true);
            ami.keepConnected();

            // Define event handlers here
            ami.on('managerevent', handle_manager_event);
            ami.on('response', handle_action_response);
            
            console.log('Connected to Asterisk');
            logger.info('Connected to Asterisk');
            
        } catch (exp) {
            logger.error('Init AMI error: ' + exp.message.red);
        }
    }
}

/**
 * Initialize the AMI connection.
 */
init_ami();

/**
 * RESTful GET method for client to retrieve config info from the server
 */
app.get('/api/config', function (req, res) {
    logger.info('Entering app.get /api/config...');
    logger.info('app.get /api/config... Received get: ' + req.body);

    res.status(200).send(configobj);
    logger.info('exiting app.get /api/config...');
});

/**
 * Makes a POST request and calls login to validate the agent username and
 * password.  If the username and password is valid, entries are added to 
 * several maps and an AMI action is sent to Asterisk to add the channel 
 * (e.g. SIP/6001) that will be used by this agent.
 * 
 * @param {type} param1
 * @param {type} param2
 */
app.post('/login', function (req, res) {
    //calls login function to validate user with REST call  
    login(req.body.username, req.body.password, function (user) {
        //Testing only. remove or set to false in live environment   
        if (false) {
            var testingonly = {
                agent_id: 0,
                username: "admin",
                first_name: "Kevin",
                last_name: "Spacey",
                role: "administrator",
                phone: "000-000-0000",
                email: "admin@portal.com",
                organization: "Organization Alpha",
                extension: 6001,
                channel: "SIP/7001"
            };
            // caToOutgoingChannelMap.set("admin", "SIP/7001");
            var token = jwt.sign(testingonly, Buffer(nconf.get('jsonwebtoken:secretkey'), nconf.get('jsonwebtoken:encoding')), {expiresIn: "10000"});
            res.status(200).json({token: token});

        } else if (user.message === 'success') {
            // Checks statusMap if user already exists
            if (statusMap.has(user.data[0].username)) {
                user.message = "User is logged in on another computer.";
                res.status(200).json(user);
            } 
            else if(user.data[0].role ==="ACL Agent"){
                res.status(200).json({"message": "ACE Connect Lite Agents cannot access ACE Direct."});
            }
            else {
                //Adds user to statusMap. 
                //Tracks if user is already logged in elsewhere
                statusMap.set(user.data[0].username, null);

                var redirect = null;
                if(user.data[0].role === "Manager"){
                    logger.info("Manager");
                    redirect = nconf.get('managementportal:url');
                    //remove status map key on redirects
                    statusMap.remove(user.data[0].username);
                }

                // profile included in the token, set to expire in 15 seconds
                var token = jwt.sign(user.data[0], Buffer(nconf.get('jsonwebtoken:secretkey'), nconf.get('jsonwebtoken:encoding')), {expiresIn: "15000"});
                res.status(200).json({message: "Success", token: token, redirect: redirect});
                
                logger.info("TOKEN queue_name: " + token.queue_name);
                logger.info("TOKEN queue2_name: " + token.queue2_name);

                if (user.data[0].queue_name) {
                    // TODO - Add AMI QueueAdd call here                
                    logger.info('ADDING QUEUE: PJSIP/' + user.data[0].extension + ', queue name ' + user.data[0].queue_name);
                    
                    ami.action({
                        "Action": "QueueAdd",
                        "Interface": "PJSIP/" + user.data[0].extension,
                        "Paused": "true",
                        "Queue": user.data[0].queue_name
                    }, function (err, res) {});
                }
                
                if (user.data[0].queue2_name) {
                    
                    logger.info('ADDING QUEUE: PJSIP/' + user.data[0].extension + ', queue name ' + user.data[0].queue2_name);
                    ami.action({
                        "Action": "QueueAdd",
                        "Interface": "PJSIP/" + user.data[0].extension,
                        "Paused": "true",
                        "Queue": user.data[0].queue2_name
                    }, function (err, res) {});
                }
                
                var interface = 'PJSIP/' + user.data[0].extension;
                var queueList = {"queue_name":user.data[0].queue_name, "queue2_name":user.data[0].queue2_name};
                
                extensionMap.set(interface, queueList);
            }
        } 
        else {
            res.status(200).json(user);
        }
    });
});

/**
 * Calls the RESTful service running on the provider host to verify the agent 
 * username and password.  
 * 
 * @param {type} username
 * @param {type} password
 * @param {type} callback
 * @returns {undefined}
 */
function login(username, password, callback) {
    // http://providerhost:port/agentverify/";
    var url = nconf.get('agentservice:url') + ":" + nconf.get('agentservice:port') + "/agentverify/";
    var params = "?username=" + username + "&password=" + password;

    request({
        url: url + params,
        json: true
    }, function (error, response, data) {
        if (error) {
            logger.error("ERROR: " + error);
            data = {"message": "failed"};
        } 
        else {
            logger.info("Agent Verify: " + data.message);
        }
        callback(data);
    });
}

app.post('/consumer_login', function (req, res) {
    getCallerInfo(req.body.vrsnumber, null, function (vrs) {
        if(vrs.message === 'success'){
            var token = jwt.sign(vrs.data[0], Buffer(nconf.get('jsonwebtoken:secretkey'), nconf.get('jsonwebtoken:encoding')), {expiresIn: "5000"});
            res.status(200).json({message: "success", token: token});
        }
        else{
            res.status(200).json(vrs);
        }
			
	});		
});


/**
 * Removes the interface (e.g. SIP/6001) from Asterisk when the agent logs out.
 * 
 * @param {type} token
 * @returns {undefined}
 */
function logout(token) {
    //removes username from statusMap
    if (token.username !== null) {
        statusMap.remove(token.username);

        // Note, we need to remove from both queues, same extension.
        if (token.queue_name) {
            logger.info('REMOVING QUEUE: PJSIP/' + token.extension + ', queue name ' + token.queue2_name);
            
            ami.action({
                "Action": "QueueRemove",
                "Interface": "PJSIP/" + token.extension,
                "Paused": "true",
                "Queue": token.queue_name
            }, function (err, res) {});
        }

        if (token.queue2_name) {
            logger.info('REMOVING QUEUE: PJSIP/' + token.extension + ', queue name ' + token.queue2_name);
            
            ami.action({
                "Action": "QueueRemove",
                "Interface": "PJSIP/" + token.extension,
                "Paused": "true",
                "Queue": token.queue2_name
            }, function (err, res) {});
        }
        
    }
}

/**
 * Calls the RESTful service running on the provider host to verify VRS number.
 * Note, this is an emulated VRS check.
 * 
 * @param {type} phone1
 * @param {type} phone2
 * @param {type} callback
 * @returns {undefined}
 */
function getCallerInfo(phone1, phone2, callback) {
    var url = nconf.get('vrscheck:url') + ":" + nconf.get('vrscheck:port');

    if (phone1) {
        url += "/vrsverify/?vrsnum=" + phone1;
    } 
    else {
        url += "/getAllVrsRecs";
    }
    request({
        url: url,
        json: true
    }, function (error, response, data) {
        if (error) {
            logger.error("ERROR: " + error);
            data = {"message": "failed"};
            
            return(data);
        }
        // if(!error && response.statusCode === 200){
        else {
            logger.info("VRS lookup response: " + data.message);
            if (data.message !== 'success' && phone2 !== null) {
                return  getCallerInfo(phone2, null, callback);
            }
        }
        callback(data);
    });
}

/**
 * Makes a REST call to retrieve the script associated with the specified
 * queueName (e.g. InboundQueue) and queueType (e.g. General).
 * 
 * @param {type} queueName
 * @param {type} queueType
 * @param {type} callback
 * @returns {undefined}
 */
function getScriptInfo(queueName, queueType, callback) {
    var url = nconf.get('scriptservice:url') + ":" + nconf.get('scriptservice:port');

    if (queueType && queueName) {
        url += '/getscript/?queue_name=' + queueType + '&type=' + queueName;
        console.log('url: ' + url);
    
        request({
            url: url,
            json: true
        }, function (error, response, data) {
            if (error) {
                logger.error("ERROR: " + error);
                data = {"message": "failed"};
            }
            // if(!error && response.statusCode === 200){
            else {
                logger.info("Script lookup response: " + data.message + JSON.stringify(data.data[0]));
                console.log("Script lookup response: " + data.message + JSON.stringify(data.data[0]));
            }
            // callback(data);
        });
    
    }
}

/**
 * Do the following here:
 * 1. Lookup and verify VRS number, retrieve VRS data
 * 2. Create Zendesk ticket, retrieve ID
 * 3. Send VRS data and Zendesk ticket ID back to consumer
 * 
 * @param {type} data
 * @returns {undefined}
 */
function processConsumerRequest (data) {      
    var resultJson = {};
    
    logger.info('processConsumerRequest - incoming ' + JSON.stringify(data));
        
    // Do the VRS lookup first
     getCallerInfo(data.vrs, null, function (vrsinfo) {

        if (vrsinfo.message === 'success') {
            
            var asteriskIp = nconf.get('asteriskAD:sip:host');
            var stunServer = nconf.get('asteriskAD:sip:stun');
            var wsPort = nconf.get('asteriskAD:sip:wsport');
            var queuesComplaintNumber = nconf.get('queues:complaint:number');
            
            logger.info('Config lookup:');
            logger.info('AsteriskIP: ' + asteriskIp);
            logger.info('STUN: ' + stunServer);
            logger.info('wsPort: ' + wsPort);
            logger.info('queuesComplaintNumber: ' + queuesComplaintNumber);
            
            logger.info('VRS contents: ' + JSON.stringify(vrsinfo));
                                                     
            /*
             *  If we get here, we have a valid VRS lookup.  Extract the
             *  data to send back to the consumer portal.  Note, the data.*
             *  fields are coming from the initial request while the vrsinfo.*
             *  fields are coming from the VRS lookup.  We're merging the 
             *  two sources here.
             */            
            var ticketId = 0;
            
            var ticket = {
                "ticket":
                  {
                    "subject":data.subject,
                    "description":data.description,
                    "requester": {
                      "name": vrsinfo.data[0].first_name,
                      "email": vrsinfo.data[0].email,
                      "phone": data.vrs,
                      "user_fields":{
                              "last_name": vrsinfo.data[0].last_name                                  
                            }
                        }
                    }
                };

                logger.info('Populated ticket: ' + JSON.stringify(ticket));

            // Create a Zendesk ticket
            zendeskClient.tickets.create(ticket,  function(err, req, result) {
                if (err) {
                    logger.error('Zendesk create ticket failure');
                    return handleError(err);
                }                

                logger.info(JSON.stringify(result, null, 2, true));
                logger.info('Ticket ID: ' + result.id);
                
                ticketId = result.id;
                
                var nextExtension = findNextAvailableExtension();
                var extensionPassword = findExtensionPassword(nextExtension);
                
                resultJson = {
                    "message":vrsinfo.message,
                    "vrs":vrsinfo.data[0].vrs,
                    "username":vrsinfo.data[0].username,
                    "first_name":vrsinfo.data[0].first_name,
                    "last_name":vrsinfo.data[0].last_name,
                    "address":vrsinfo.data[0].address,
                    "city":vrsinfo.data[0].city,
                    "state":vrsinfo.data[0].state,
                    "zip_code":vrsinfo.data[0].zip_code,
                    "email":vrsinfo.data[0].email,
                    "zendesk_ticket":ticketId,
                    "subject":data.subject,
                    "description":data.description,
                    "extension":nextExtension,
                    "asterisk_ip":asteriskIp,
                    "stun_server":stunServer,
                    "ws_port":wsPort,
                    "password":extensionPassword,
                    "queues_complaint_number":queuesComplaintNumber
                };
                
                logger.info('Extension to VRS Mapping: ' + nextExtension + ' => ' + vrsinfo.data[0].vrs);
                
                extensionToVrs.set(nextExtension, vrsinfo.data[0].vrs);
                
                logger.info('vrsToZenId map addition: ' + data.vrs + ' => ' + ticketId);
                vrsToZenId.set(vrsinfo.data[0].vrs, ticketId);
				
                //TODO: Put Emit here (ad-ticket-created)
                io.to(Number(vrsinfo.data[0].vrs)).emit('ad-ticket-created', resultJson);
                
                logger.info('EMIT: ad-ticket-created: ' + JSON.stringify(resultJson));                
            });
                                      
        } 
        else {
            logger.warn('Consumer portal VRS lookup failed');
            
            // Send this back to the portal via Socket.IO
            resultJson = {"message":"failure"};
            
            io.to('my room').emit('ad-ticket-created', resultJson);
            logger.info('EMIT: ad-ticket-created: ' + resultJson);
        }
    });    
}

/**
 * Update an existing Zendesk ticket.
 * 
 * @param {type} data
 * @returns {undefined}
 */
function updateZendeskTicket (data) {      	
    var ticketId = data.ticketId;
    
	var ticket = {
		"ticket":
		{
			"subject": data.subject,
			"description": data.description,
			"requester": {
				"name": data.name,
				"email": data.email,
				"phone": data.phone,
				"user_fields":{
					"last_name": data.last_name                                  
				}
			},                        
                        "status":data.status,
                        "comment":data.comment,
                        "resolution":data.resolution
		}
	};
        
        logger.info('\n****** Zendesk update in ticket: ' + JSON.stringify(ticket));
        logger.info('\n****** Zendesk update in data: ' + JSON.stringify(data));

	// Update a Zendesk ticket
	zendeskClient.tickets.update(ticketId, ticket,  function(err, req, result) {
		if (err) {
			logger.error('***** Zendesk update ticket failure');
			return handleError(err);
		}
		
		logger.info('***** Zendesk update results: ' + JSON.stringify(result));
		
		//TODO: Put Emit here for updated ticket
		//io.to(Number(vrsinfo.data[0].vrs)).emit('ad-ticket-udpated', resultJson); MUST EMIT TO CSR (not Consumer)
		// logger.info('EMIT: ad-ticket-updated: ' + JSON.stringify(result));         
                
                logger.info('EMIT: ad-zendesk-update-success: ');         
                io.to(Number(data.destexten)).emit('ad-zendesk-update-success', result);
	}); 
}

/**
 * 
 * @param {type} err
 * @returns {undefined}
 */
function handleError(err) {
    console.log(err);
    process.exit(-1);
}

/**
 * 
 * @returns {undefined}
 */
function prepareExtensions() {
    var exts = nconf.get('extensions');
        
    if (exts) {
        logger.info('Extensions start: ' + exts.startnumber + " end: " + exts.endnumber);
        for (var num = exts.startnumber; num <= exts.endnumber; num++) {
            var data = {"secret": exts.secret, "inuse": false};            
            consumerExtensions.set(Number(num), data);
        }
    }
}

/**
 * 
 * @returns {findNextAvailableExtension.keys|Number}
 */
function findNextAvailableExtension() {
    var keys = consumerExtensions.keys();
    var nextExtension = 0;
    
    for (var i = 0; i < keys.length; i++) {
        logger.info(keys[i] + ' => ' + JSON.stringify(consumerExtensions.get(keys[i])));

        var val = consumerExtensions.get(keys[i]);

        if (val.inuse === false) {
            logger.info('Found an open extension in consumerExtensions: ' + keys[i]);
            val.inuse = true;
            
            consumerExtensions.set(keys[i], val);
            
            nextExtension = keys[i];
            break;
        }                
    }

    logger.info('After setting extension to busy');

    for (var i = 0; i < keys.length; i++ ) {
       logger.info(keys[i] + ' => ' + JSON.stringify(consumerExtensions.get(keys[i])) );
    }

    return(nextExtension);
}

/**
 * 
 * @param {type} extension
 * @returns {json.secret|String|consumerExtensions@call;get.secret}
 */
function findExtensionPassword(extension) {
    
    var password = 'unknown';
    
    logger.info('Entering findExtensionPassword() for extension: ' + extension);
    
    if (consumerExtensions.has(Number(extension)) ) {
        logger.info('Found a match in the consumerExtensions map');
        var json = consumerExtensions.get(Number(extension));
        
        password = json.secret;        
        
        logger.info('Found a match in the consumerExtensions map with password: ' + password);
    }
    
    return(password);
}

/**
 * Perform VRS lookup and Zendek ticket creation.
 * 
 * @param {type} vrsNum
 * @param {type} destAgentExtension
 * @returns {undefined}
 */
function vrsAndZenLookup(vrsNum, destAgentExtension) {

    logger.info('Performing VRS lookup for number: ' + vrsNum + ' to agent ' + destAgentExtension);

    if (vrsNum) {
        logger.info('Performing VRS lookup for number: ' + vrsNum + ' to agent ' + destAgentExtension);

        // Do the VRS lookup 
        getCallerInfo(vrsNum, null, function (vrsinfo) {
            
            logger.info('vrsinfo: ' + JSON.stringify(vrsinfo));

            if (vrsinfo.message === 'success') {

                logger.info('#### EMIT to room ' + destAgentExtension);
                logger.info('VRS lookup success');
                logger.info('#### EMIT VRS contents: ' + JSON.stringify(vrsinfo));

                // EMIT HERE ad-vrs
                io.to(Number(destAgentExtension)).emit('ad-vrs', vrsinfo);
            }
            else if (vrsinfo.message === 'vrs number not found') {

                logger.info('#### EMIT missing-vrs');
                io.to(Number(destAgentExtension)).emit('missing-vrs', vrsinfo);
            }
        });
    }
    else if (vrsNum === 0 || vrsNum === null) {
        logger.info('#### EMIT missing-vrs - blank case');
        io.to(Number(destAgentExtension)).emit('missing-vrs', {"message":"vrs number not found"});        
    }
    else {
        logger.error('Could not find VRS in vrsAndZenLookup()');
    }

    var zenTicketId = vrsToZenId.get(vrsNum);                
    if (zenTicketId) {
        logger.info('Performing Zendesk ticket lookup for ticket: ' + zenTicketId);

        zendeskClient.tickets.show(zenTicketId, function (err, statusList, body, responseList, resultList) {
            var resultJson = {"message":"failure"};
            if (err) {
                logger.info('##### Zendesk error: ' + err);
            }
            else {
                logger.info('zendeskLookup() result: ' + JSON.stringify(body, null, 2, true));
                resultJson = body;
            }

            // emit here                    
            // EMIT HERE ad-zendesk
            logger.info('#### EMIT to room: ' + destAgentExtension);
            logger.info('#### EMIT Zendesk show resultJson: ' + JSON.stringify(resultJson));
            io.to(Number(destAgentExtension)).emit('ad-zendesk', resultJson);
        });
    }
    else {
        logger.error('Could not find Zendesk ticket ID in vrsAndZenLookup()');
    }
}

// Populate the consumerExtensions map - 90001, 90002, ...
prepareExtensions();
var ctoken = jwt.sign({tokenname: "servertoken"}, Buffer(nconf.get('jsonwebtoken:secretkey'), nconf.get('jsonwebtoken:encoding')));

