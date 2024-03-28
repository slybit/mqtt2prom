'use strict'

const express = require('express');
const mustache = require('mustache');
const mqtt = require('mqtt');
const client = require('prom-client');
const register = client.register;
const { logger } = require('./standardlogger.js');
const config = require('./config.js').parse();


let justStarted = true;



// collection of all metrics we will be accumulating
const metrics = {};

const parse = function (topic, message) {
    // ensure data is Object
    let whitelist = /[^0-9a-zA-Z]/gi;
    let data = {};
    data.M = processMessage(message);
    for (const r of config.rewrites) {
        let regex = RegExp(r.regex);
        data.T = regex.exec(topic);
        if (data.T) {
            let name = render(r.name, data);
            // make sure the name is compliant with Prometheus metric names
            name = name.replace(whitelist, "_");
            let metric = undefined;
            // new metric, create it
            if (!(name in metrics)) {
                metric = new client.Gauge({
                    name: name,
                    help: name,
                    labelNames: r.labels ? Object.keys(r.labels) : []
                });
                metrics[name] = metric;
                // or reuse an exiting metric
            } else {
                metric = metrics[name];
            }

            let labels = {};
            if (r.labels) {
                for (var label in r.labels) {
                    labels[label] = render(r.labels[label], data);
                }
            }
            let value = undefined;
            value = render(r.value, data);
            if (!isNaN(value)) value = Number(value);
            if (isNaN(value)) value = 0;

            if (name && value !== undefined && !isNaN(value)) {
                try {
                    metric.set(labels, value);
                    logger.verbose("Created metric with value", {'name': name, 'value': value});
                } catch (err) {
                    logger.error("Could not create metric", {'error' : err.message});
                }
            } else {
                if (isNaN(value))
                    logger.warn('Rewrite resulted in non-numeric value. No metric updated.');
                if (!name)
                    logger.warn('Rewrite resulted in empty name. No metric updated.');
                if (value === undefined)
                    logger.warn('Rewrite resulted in empty value.  No metric updated.');
            }

            // break the for loop if topic matched and config does not say "continue : true"
            if (!(r.continue === true)) break;
        }

    }

}


const render = function (template, data) {
    if (typeof (template) === 'string') {
        return mustache.render(template, data);
    } else {
        return template;
    }
}

// evaluates the mqtt message
// expects message to be a string
let processMessage = function (message) {
    let data = {};
    if (message === 'true') {
        data = 1;
    } else if (message === 'false') {
        data = 0;
    } else if (isNaN(message)) {
        try {
            data = JSON.parse(message);
        } catch (err) {
            data = message; // will be a string
        }
    } else {
        data = Number(message);
    }
    return data;
}




const setMqttHandlers = function (mqttClient) {
    mqttClient.on('connect', function () {
        logger.info('MQTT connected');
        for (const topic of config.topics) {
            mqttClient.subscribe(topic);
            logger.verbose('subscribed to topic', {'topic': topic});
        }
    });

    mqttClient.on('close', function () {
        logger.info('MQTT disconnected');
    });

    mqttClient.on('reconnect', function () {
        logger.info('MQTT trying to reconnect');
    });

    mqttClient.on('message', function (topic, message, packet) {
        // ignore the initial retained messages
        if (!packet.retain) justStarted = false;
        if (!justStarted || config.retained) {
            // message is a buffer
            logger.silly("MQTT received", {'topic': topic, 'message': message})
            message = message.toString();
            parse(topic, message);
        } else {
            logger.silly("MQTT ignored initial retained", {'topic': topic, 'message': message})
        }
    });
}

// mqtt listener
let mqttClient = mqtt.connect(config.mqtt.url, config.mqtt.options);
setMqttHandlers(mqttClient);



// express server
const server = express();

let path = (config.prometheus && config.prometheus.path) ? '/' + config.prometheus.path : '/metrics';
let port = (config.prometheus && config.prometheus.port) ? config.prometheus.port : 6000;
server.get(path, (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(register.metrics());
})

logger.info('Server listening on port, metrics exposed on path', {'port': port, 'path': path});
server.listen(port);