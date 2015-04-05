//setup node web server
// require needed modules
var api = require('./routes/api'),
    async = require('async'), //allow better formatting for asynchronous calls - https://github.com/caolan/async
    bodyParser = require('body-parser'),
    datastore = require('nedb'),
    express = require('express'),
    fs = require('fs'),
    gpio = require('rpi-gpio'), // allow use of gpio - https://www.npmjs.com/package/rpi-gpio
    http = require('http'),
    log = require('npmlog'),
    methodOverride = require('method-override'),
    morgan = require('morgan'),
    path = require('path'),
    routes = require('./routes'),
    serialport = require('serialport'),
    url = require('url'),
    xml2js = require('xml2js');
// setup ip and port
var ip = process.argv[2] || '192.168.1.116', // has to be actual ip of device
    port = process.argv[3] || 8080;

var app = module.exports = express();
// sets port 8080 to default unless otherwise specified via script init argument
app.set('port', port);
// localize serialport object constructor
var SerialPort = serialport.SerialPort;

// object for each part of application
var File = {
    readOptions : {
        encoding: 'utf8'
    },
    watchOptions: {
        persistent: true
    },
    applicationPath: '/home/pi/roboFeeder'
};
var Database = {
    datastore: new datastore({ filename: File.applicationPath + '/db/roboFeeder.db', autoload: true }),
    init: function(){
        // do nothing currently
        Log.log.info('Database', 'Database initialized');
    }
};
var Rfid = {
    allowedTagsFileName: 'allowedTags.xml',
    //allowedTags uses strings to preserve leading zeros
    allowedTags: [],
    lastTrigger: null,
    parseXMLString : require('xml2js').parseString,
    xmlBuilder : new xml2js.Builder({rootName: 'codes'}),
    getAllowedTags: function(){
        fs.readFile(File.applicationPath + '/' + Rfid.allowedTagsFileName, File.readOptions, function (err, data) {
            if (err) throw err;
            Rfid.parseXMLString(data, function (err, result) {
                Rfid.allowedTags = result['codes']['code'] || [];
            });
        });
    },
    watchAllowedTagsFile: function(){
        fs.watch(File.applicationPath + '/' + Rfid.allowedTagsFileName, File.watchOptions, function(event, filename) {
            console.log(event + " event occurred on " + filename);
        });
    },
    setLastTrigger: function(){
        var date = new Date();
        var unix_secs = date.getTime();
        Rfid.lastTrigger = unix_secs;
        Toolbox.printDebugMsg('Rfid.lastTrigger set: ' + unix_secs);
    },
    saveAllowedTags: function(xml){
        fs.writeFile(
            File.applicationPath + '/' + Rfid.allowedTagsFileName,
            xml,
            function(err) {
                if(err) {
                    return console.log(err);
                }
                console.log("The allowed Tags XML file was saved.");
            }
        );
    },
    saveAllowedTag: function(tag){
        Rfid.allowedTags.push(tag);
        Rfid.allowedTags = Toolbox.uniq(Rfid.allowedTags);
        var xml = Rfid.allowedTagsToXML();
        Rfid.saveAllowedTags(xml);
    },
    removeAllowedTag: function(tag){
        var tagIndex = Rfid.allowedTags.indexOf(tag);
        if (tagIndex > -1) {
            Rfid.allowedTags.splice(tagIndex, 1);
        }
        var xml = Rfid.allowedTagsToXML();
        Rfid.saveAllowedTags(xml);
    },
    allowedTagsToXML: function(){
        var obj = {code: Rfid.allowedTags};
        var xml = Rfid.xmlBuilder.buildObject(obj);
        return xml;
    },
    init: function(){
        //read allowed tags from file
        Rfid.getAllowedTags();
        //setup watch on file to get changes
        Rfid.watchAllowedTagsFile();
        RoboFeeder.status.rfid = true;
        Log.log.info('Rfid', 'RFID initialized');
    }
};
var Motor = {
    reversePin: 16,
    forwardPin: 18,
    enablePin: 22,
    runTime: 2800,
    waitTime: 5000,
    running: false,
    on: function(){
        //turns on the motor drive pin
        //needs to be called with Motor.forward or Motor.reverse to actually run motor
        //Toolbox.printDebugMsg('Motor.on called');
        //Toolbox.printDebugMsg('Motor.running: ' + Motor.running);
        if(!Motor.running){
            Motor.running = true;
            gpio.write(Motor.enablePin, true, function(err) {
                if (err) throw err;
                //Toolbox.printDebugMsg('Motor.enablePin ' + Motor.enablePin + ' set HIGH');
            });
        }
    },
    off: function(){
        //turns all the way off all three pins involved
        //Toolbox.printDebugMsg('Motor.off called');
        //Toolbox.printDebugMsg('Motor.running: ' + Motor.running);
        Motor.running = false;
        gpio.write(Motor.enablePin, false, function(err) {
            if (err) throw err;
            Toolbox.printDebugMsg('Motor.enablePin ' + Motor.enablePin + ' set LOW.');
        });
        gpio.write(Motor.forwardPin, false, function(err) {
            if (err) throw err;
            Toolbox.printDebugMsg('Motor.forwardPin ' + Motor.forwardPin + ' set LOW.');
        });
        gpio.write(Motor.reversePin, false, function(err) {
            if (err) throw err;
            Toolbox.printDebugMsg('Motor.reversePin ' + Motor.reversePin + ' set LOW.');
        });
    },
    forward: function(){
        //Toolbox.printDebugMsg('Motor.forward called');
        Motor.on();
        gpio.write(Motor.forwardPin, true, function(err) {
            if (err) throw err;
            //Toolbox.printDebugMsg('Motor.forwardPin ' + Motor.forwardPin + ' set HIGH.');
        });
        gpio.write(Motor.reversePin, false, function(err) {
            if (err) throw err;
            //Toolbox.printDebugMsg('Motor.reversePin ' + Motor.reversePin + ' set LOW.');
        });
    },
    reverse: function(){
        //Toolbox.printDebugMsg('Motor.reverse called');
        Motor.on();
        gpio.write(Motor.reversePin, true, function(err) {
            if (err) throw err;
            //Toolbox.printDebugMsg('Motor.reversePin ' + Motor.reversePin + ' set HIGH');
        });
        gpio.write(Motor.forwardPin, false, function(err) {
            if (err) throw err;
            //Toolbox.printDebugMsg('Written to pin: ' + Motor.reversePin + ' set LOW');
        });
    },
    init: function(){
        async.parallel([
            function(callback){
                gpio.setup(Motor.forwardPin, gpio.DIR_OUT, callback)
            },
            function(callback){
                gpio.setup(Motor.reversePin, gpio.DIR_OUT, callback)
            },
            function(callback){
                gpio.setup(Motor.enablePin, gpio.DIR_OUT, callback)
            },
        ], function(err, results){
            Toolbox.printDebugMsg('Motor Pins setup');
            Toolbox.printDebugMsg('Running initial open/close cycle without enabling PIR monitoring');
            RoboFeeder.cycle(false);
            RoboFeeder.status.motor = true;
            Log.log.info('Motor', 'Motor initialized');
        });
    }
};
var Gpio = {
    bindChange: function(){
        gpio.on('change', function(channel, value){
            //send monitoring data to server for monitor on site
            Toolbox.printDebugMsg('Channel ' + channel + ' value is now ' + value);
        });
    },
    closePins: function(){
        gpio.destroy(function() {
            Toolbox.printDebugMsg('--- All pins un-exported, gpio closed ---');
            return process.exit(0);
        });
    },
    init: function(){
        //bind change of GPIO pins if debugging
        if(Toolbox.debug){
            Gpio.bindChange();
        }
        Log.log.info('Gpio', 'GPIO initialized');
    }
};
var Toolbox = {
    debug: true, //turns on all debugging console.log messages
    zeroFill: function(number, width){
        width -= number.toString().length;
        if ( width > 0 )    {
            return new Array( width + (/\./.test( number ) ? 2 : 1) ).join( '0' ) + number;
        }
        return number + ""; // always return a string
    },
    printDebugMsg: function(msg){
        if(Toolbox.debug){
            console.log(msg);
        }
    },
    uniq: function(a) {
        var prims = {"boolean":{}, "number":{}, "string":{}}, objs = [];

        return a.filter(function(item) {
            var type = typeof item;
            if(type in prims)
                return prims[type].hasOwnProperty(item) ? false : (prims[type][item] = true);
            else
                return objs.indexOf(item) >= 0 ? false : objs.push(item);
        });
    }
};
var Serial = {
    sp: new SerialPort("/dev/ttyAMA0", {
        baudrate: 9600,
        parser: serialport.parsers.raw
    }),
    receiveData: function(data){
        var buff = new Buffer(data, 'utf8');
        var encoded_hex = buff.toString('hex');
        var encoded_int = parseInt(encoded_hex, 16);
        //Toolbox.printDebugMsg('data received: ' + data);
        //Toolbox.printDebugMsg('encoded hex data: ' + encoded_hex);
        //Toolbox.printDebugMsg('encoded int data: ' + encoded_int);
        Serial.checkCode(encoded_int, RoboFeeder.status.open);
    },
    checkCode: function(code, rechecking){
        //Toolbox.printDebugMsg('checkCode - incoming code: ', code);
        zerofilled_code = Toolbox.zeroFill(code, 8);
        //Toolbox.printDebugMsg('zerofilled code: ', zerofilled_code);
        var codeIndex = null;
        for(var i=0; i < Rfid.allowedTags.length; i++){
            //Toolbox.printDebugMsg('Rfid.allowedTags[i]: ', Rfid.allowedTags[i]);
            if(Rfid.allowedTags[i] == zerofilled_code){
                codeIndex = i;
                break;
            }
        }
        //Toolbox.printDebugMsg('codeIndex: ', codeIndex);
        if(codeIndex !== null){
            if(!rechecking){
                RoboFeeder.open();
                Pir.monitor();
            }
            Toolbox.printDebugMsg('RFID tag match: ' + code);
            Rfid.setLastTrigger();
            /*if(codeIndex === 0){
                //white tag index 0
                Toolbox.printDebugMsg('white tag match: ', code);
                Motor.forward();
            }
            else if(codeIndex === 1){
                //blue tag index 1
                Toolbox.printDebugMsg('blue tag match: ', code);
                Motor.reverse();
            }*/
        }
    },
    init: function(){
        Serial.sp.on('open', function() {
            Toolbox.printDebugMsg('Serial connection open.');
            Serial.sp.on('data', function(data) {
                Serial.receiveData(data);
            });
        });
        RoboFeeder.status.serial = true;
    }
};
var Pir = {
    // Passive InfraRed Sensor
    enablePin: 11,
    sensorPin: 12,
    lastTrigger: null,
    checkFrequency: 50,
    enable: function(){
        gpio.write(Pir.enablePin, true, function(err) {
            if (err) throw err;
            Toolbox.printDebugMsg('Pir.enablePin ' + Pir.enablePin + ' set HIGH');
        });
    },
    disable: function(){
        gpio.write(Pir.enablePin, false, function(err) {
            if (err) throw err;
            Toolbox.printDebugMsg('Pir.enablePin ' + Pir.enablePin + ' set LOW');
        });
    },
    read: function(){
        gpio.read(Pir.sensorPin, function(err, value) {
            console.log('The Pir sensor pin value is ' + value);
            return value;
        });
    },
    monitor: function(){
        Pir.enable();
        var ee = new process.EventEmitter(),
            pinState;

        ee.on('stateChange', function(previousValue, value){
            console.log('PIR sensor pin state changed from', previousValue, 'to', value);
            Pir.setLastTrigger();
        });

        Pir.intervalTimer = setInterval(function(){
            gpio.read(Pir.sensorPin, function(err, value) {
                if(err){
                    ee.emit('error', err);
                }
                else{
                    if(pinState !== value){
                        var previousState = pinState;
                        pinState = value;
                        ee.emit('stateChange', previousState, value);
                    }
                }
            });
        }, Pir.checkFrequency);
    },
    monitorEnd: function(){
        Pir.disable();
        clearInterval(Pir.intervalTimer);
    },
    setLastTrigger: function(){
        var date = new Date();
        var unix_secs = date.getTime();
        Pir.lastTrigger = unix_secs;
        Toolbox.printDebugMsg('Pir.lastTrigger set: ' + unix_secs);
    },
    init: function(){
        async.parallel([
            function(callback){
                gpio.setup(Pir.enablePin, gpio.DIR_OUT, callback)
            },
            function(callback){
                gpio.setup(Pir.sensorPin, gpio.DIR_IN, callback)
            },
        ], function(err, results){
            Pir.enable();
            Pir.read();
            Pir.disable();
            RoboFeeder.status.pir = true;
            Log.log.info('Pir', 'PIR pins setup and sensor tested');
        });
    }
};
var Output = {
    // Status indication LEDs, etc.
    init: function(){
        // TODO
    }
};
var Log = {
    log: log,
    items: [],
    init: function(){
        // setup event listener to save our npmlog events to the db log
        Log.log.on('log', function(stream){
            Log.saveItem(stream);
        });
        Log.load();
        Log.log.info('Log', 'Log initialized and log items loaded');
    },
    saveItem: function(stream){
        console.log(stream);
        var date = new Date();
        var unix_secs = date.getTime();
        var logItem = {
            type: 'log',
            level: stream.level,
            category: stream.prefix,
            message: stream.message,
            timestamp: unix_secs
        };
        Database.datastore.insert(logItem, function (err, newDoc) {   // Callback is optional
            // DO NOT log this to the npmlog because it will trigger a loop...
            // newDoc is the newly inserted document, including its _id
            console.log('Log.saveItem - newDoc');
            console.log(newDoc);
        });
    },
    load: function(){
        Database.datastore.find({type: 'log'}, function (err, docs) {
            //console.log('Log.load');
            //console.log(docs);
            if(typeof docs[0] != "undefined"){
                for (var i=0; i < docs.length; i++) {
                    logItem = {
                        message: docs[i]['message'],
                        level: docs[i]['level'],
                        category: docs[i]['category'],
                        timestamp: docs[i]['timestamp']
                    };
                    Log.items.push(logItem);
                }
            }
            return Log.items;
        });
    },
    reset: function(){
        // Remove multiple documents
        Database.datastore.remove({ type: 'log' }, { multi: true }, function (err, numRemoved) {
            // DO NOT log this to the npmlog because it will trigger a loop...
            // newDoc is the newly inserted document, including its _id
            console.log('Log.reset - numRemoved');
            console.log(numRemoved);
            Log.items = [];
            return Log.items;
        });
    }
};
var RoboFeeder = {
    //for higher level functions and variables
    settings: {
        // set from db, configurable from ui
        //time in milliseconds, default to 10 seconds
        pirThreshold: '', // pir threshold for closing
        rfidThreshold: '' // rfid threshold for closing

    },
    defaultSettings: {
        rfidThreshold : 10000,
        pirThreshold : 10000
    },
    status: {
        open: false,
        pir: false,
        rfid: false,
        motor: false,
        serial: false
    },
    intervalTimer: '',
    openTimer: '',
    checkFrequency: 100,
    open: function(enable){
        if(enable !== false){
            enable = true;
        }
        Motor.reverse();
        RoboFeeder.status.open = true;
        RoboFeeder.openTimer = setTimeout(
            function(){ RoboFeeder.openCallback(enable); },
            Motor.runTime
        );
    },
    openCallback: function(enable){
        Motor.off();
        if(enable){
            Pir.monitor();
            RoboFeeder.monitor();
        }
    },
    close: function(){
        Motor.forward();
        RoboFeeder.status.open = false;
        RoboFeeder.openTimer = setTimeout(
            RoboFeeder.closeCallback,
            Motor.runTime
        );
    },
    closeCallback: function(){
        Motor.off();
    },
    cycle: function(enable){
        if(enable !== false){
            enable = true;
        }
        RoboFeeder.open(enable);
        setTimeout(
            RoboFeeder.close,
            Motor.waitTime
        );
    },
    loadSettings: function(){
        Database.datastore.find({type: 'setting'}, function (err, docs) {
            if(typeof docs[0] != "undefined"){
                var count = 0;
                for (var setting in RoboFeeder.settings) {
                    RoboFeeder.settings[setting] = docs[count]['value'];
                    //console.log('RoboFeeder.settings.' + docs[count]['name']);
                    //console.log(RoboFeeder.settings[setting]);
                    count++;
                }
            }
            else{
                // if cannot get settings from db use default settings
                RoboFeeder.settings = RoboFeeder.defaultSettings;
            }
        });
    },
    monitor: function(){
        var ee = new process.EventEmitter(),
            rfid = false,
            pir = false;

            ee.on('stateChange', function(event_name){
            Toolbox.printDebugMsg('roboFeeder monitor event emitter triggered: ' + event_name);
        });

        RoboFeeder.intervalTimer = setInterval(function(){
            var date = new Date();
            var unix_secs = date.getTime();

            if(unix_secs - RoboFeeder.settings.pirThreshold >= Pir.lastTrigger){
                //Toolbox.printDebugMsg('RoboFeeder.intervalTimer - Pir.lastTrigger: ' + Pir.lastTrigger);
                if(!pir){
                    ee.emit('stateChange', 'PIR: past interval');
                    pir = true;
                }
            }
            else{
                if(pir){
                    ee.emit('stateChange', 'PIR: reset interval');
                    pir = false;
                }
            }
            if(unix_secs - RoboFeeder.settings.rfidThreshold >= Rfid.lastTrigger){
                //Toolbox.printDebugMsg('RoboFeeder.intervalTimer - Rfid.lastTrigger: ' + Rfid.lastTrigger);
                if(!rfid){
                    ee.emit('stateChange', 'RFID: past interval');
                    rfid = true;
                }
            }
            else{
                if(rfid){
                    ee.emit('stateChange', 'RFID: reset interval');
                    rfid = false;
                }
            }
            if(pir && rfid){
                Pir.monitorEnd();
                RoboFeeder.monitorEnd();
                RoboFeeder.close();
            }
        }, RoboFeeder.checkFrequency);
    },
    monitorEnd: function(){
        clearInterval(RoboFeeder.intervalTimer);
    },
    openTimerEnd: function(){
        clearInterval(RoboFeeder.openTimer);
    },
    init: function(){
        Log.init();
        Database.init();
        RoboFeeder.loadSettings();
        Rfid.init();
        Serial.init();
        Gpio.init();
        Motor.init();
        Pir.init();
        Output.init();
        WebServer.init();
    }
};
var WebServer = {
    init: function(){
        app.set('views', File.applicationPath + '/views');
        app.set('view engine', 'jade');
        app.use(morgan('dev'));
        app.use(bodyParser.urlencoded({ extended: true }));
        app.use(bodyParser.json());
        app.use(methodOverride());
        app.use(express.static(path.join(__dirname, 'public')));

        //WebServer.setupEnvironment();
        /** Routes */
        // serve index and view partials
        app.get('/', routes.index);
        app.get('/partials/:name', routes.partials);
        WebServer.setupApi();
        // redirect all others to the index (HTML5 history)
        app.get('*', routes.index);

        WebServer.create();
    },
    setupApi: function(){
        // JSON API allows requests from front end to accomplish tasks
        // tags
        app.get('/api/tags/allowed/get', function(req, res){
            return res.json({ allowedTags: Rfid.allowedTags });
        });
        app.post('/api/tags/allowed/add', function(req, res){
            if(typeof req.body.tag != "undefined"){
                Rfid.saveAllowedTag(req.body.tag);
            }
            return res.json({ allowedTags: Rfid.allowedTags });
        });
        app.post('/api/tags/allowed/remove', function(req, res){
            if(typeof req.body.tag != "undefined"){
                Rfid.removeAllowedTag(req.body.tag);
            }
            return res.json({ allowedTags: Rfid.allowedTags });
        });
        // manual open
        app.get('/api/open', function(req, res){
            RoboFeeder.openTimerEnd();
            RoboFeeder.open(false);
            RoboFeeder.openTimerEnd();
            setTimeout(
                function(){ return res.json({ status: RoboFeeder.status.open }); },
                Motor.runTime
            );
        });
        // manual close
        app.get('/api/close', function(req, res){
            RoboFeeder.openTimerEnd();
            RoboFeeder.close();
            RoboFeeder.openTimerEnd();
            setTimeout(
                function(){ return res.json({ status: RoboFeeder.status.open }); },
                Motor.runTime
            );
        });
        // statuses
        app.get('/api/status/open', function(req, res){
            return res.json({ status: RoboFeeder.status.open });
        });
        app.get('/api/status/pir', function(req, res){
            return res.json({ status: RoboFeeder.status.pir });
        });
        app.get('/api/status/rfid', function(req, res){
            return res.json({ status: RoboFeeder.status.rfid });
        });
        app.get('/api/status/motor', function(req, res){
            return res.json({ status: RoboFeeder.status.motor });
        });
        app.get('/api/status/serial', function(req, res){
            return res.json({ status: RoboFeeder.status.serial });
        });
        // settings
        app.get('/api/settings/get', function(req, res){
            return res.json({ roboFeederSettings: RoboFeeder.settings });
        });
        app.post('/api/settings/save', function(req, res){
            if(typeof req.body.roboFeederSettings != "undefined"){
                RoboFeeder.settings = req.body.roboFeederSettings;
                for(var roboFeederSetting in RoboFeeder.settings){
                    // Set an existing field's value
                    Database.datastore.update({ name: roboFeederSetting }, { $set: { value: RoboFeeder.settings[roboFeederSetting] } }, {}, function (err, numReplaced) {
                        console.log('Database.datastore.update - ' + roboFeederSetting);
                        console.log('numReplaced: ' + numReplaced);
                    });
                }
                console.log('app.post(\'/api/settings/save\' - RoboFeeder.settings');
                console.log(RoboFeeder.settings);
            }
            return res.json({ roboFeederSettings: RoboFeeder.settings });
        });
        app.get('/api/settings/reset', function(req, res){
            RoboFeeder.settings = RoboFeeder.defaultSettings;
            return res.json({ roboFeederSettings: RoboFeeder.settings });
        });
        //log
        app.get('/api/log/get', function(req, res){
            return res.json({ log: Log.items });
        });
        app.get('/api/log/reset', function(req, res){
            Log.reset();
            return res.json({ log: Log.items });
        });

    },
    setupEnvironment: function(){
        /* TODO - decide if needed: not sure if I want this - leaving it for now
         var env = process.env.NODE_ENV || 'development';
         // development only
         if (env === 'development') {
         app.use(express.errorHandler());
         }
         // production only
         if (env === 'production') {
         // noting setup for production
         }*/
    },
    create: function(){
        var server = app.listen(port, ip, function () {
            var host = server.address().address;
            var port = server.address().port;
            console.log('RoboFeeder app listening at http://%s:%s', host, port);
        });
    }
};

// -- DO STUFF --
RoboFeeder.init();
