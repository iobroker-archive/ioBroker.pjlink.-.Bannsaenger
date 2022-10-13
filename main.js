/**
 *
 *      iobroker pjlink Adapter
 *
 *      Copyright (c) 2022, Bannsaenger <bannsaenger@gmx.de>
 *
 *      MIT License
 *
 *      Created with @iobroker/create-adapter 2.1.1
 *
 */

const utils = require('@iobroker/adapter-core');
const pjlink = require('pjlink');

/** Projector status constants
    Four possible power states:
    * 0	/	pjlink.POWER.OFF
    * 1 /	pjlink.POWER.ON
    * 2 /	pjlink.POWER.COOLING_DOWN
    * 3 /	pjlink.POWER.WARMING_UP
 */


class Pjlink extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'pjlink',
        });
        // register callback functions
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        // prepare global instance variables
        this.projector = undefined;
        this.connectedState = false;        // true if connection to projector is established, will be reset on connection errors
        this.timers = {};                   // a place to store timers
        this.timers.reconnectDelay = undefined;
        this.timers.statusDelay = undefined;
        this.timers.informationDelay = undefined;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        try {
            //const self = this;
            // Reset the connection indicator during startup
            this.setState('info.connection', false, true);

            this.conOptions = {
                'host': this.config.host || '127.0.0.1',
                'port': this.config.port || 4352,
                'password': this.config.password || null,
                'timeout': this.config.socketTimeout || 100
            };

            // In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
            this.subscribeStates('power');
            this.subscribeStates('input');
            this.subscribeStates('videoMuteStatus');
            this.subscribeStates('audioMuteStatus');

            this.log.info(`PJLink connecting to host: ${this.conOptions.host}:${this.conOptions.port} (timeout: ${this.conOptions.timeout} ms), ${this.conOptions.password ? 'with password set' : 'with security disabled'}`);

            // instantiate connection object for the projector
            this.projector = new pjlink(this.conOptions);

            // try to communicate to the projector
            this.reconnectProjector();

        } catch (err) {
            this.errorHandler(err, 'onReady');
        }
    }

    /**
     * Called to reconnect to the projector
	 */
    reconnectProjector() {
        try {
            this.log.info(`PJLink trying to reconnect to projector`);
            // only the getPowerState for now
            this.projector.getPowerState(this.pjlinkAnswerHandler.bind(this, 'GETPOWERSTATE'));
        } catch (err) {
            this.errorHandler(err, 'reconnectProjector');
        }
    }

    /**
     * Called to refresh the projector status (power, mute and input)
	 */
    getProjectorStatus() {
        try {
            this.log.debug(`PJLink requesting projector status`);
            this.projector.getPowerState(this.pjlinkAnswerHandler.bind(this, 'GETPOWERSTATE'));
            this.projector.getInput(this.pjlinkAnswerHandler.bind(this, 'GETINPUT'));
            this.projector.getMute(this.pjlinkAnswerHandler.bind(this, 'GETMUTE'));
            if (this.timers.statusDelay) {
                this.timers.statusDelay.refresh();
                this.log.debug(`PJLink refreshing statusDelay`);
            } else {
                this.log.debug(`PJLink unable to refresh statusDelay`);
            }
        } catch (err) {
            this.errorHandler(err, 'getProjectorStatus');
        }
    }

    /**
     * Called to refresh the projector information (name, etc.)
	 */
    getProjectorInformation() {
        try {
            this.log.debug(`PJLink requesting projector information`);
            // first get all status states
            this.getProjectorStatus();
            // and then all additional information
            this.projector.getErrors(this.pjlinkAnswerHandler.bind(this, 'GETERRORS'));
            this.projector.getLamps(this.pjlinkAnswerHandler.bind(this, 'GETLAMPS'));
            this.projector.getInputs(this.pjlinkAnswerHandler.bind(this, 'GETINPUTS'));
            this.projector.getName(this.pjlinkAnswerHandler.bind(this, 'GETNAME'));
            this.projector.getManufacturer(this.pjlinkAnswerHandler.bind(this, 'GETMANUFACTURER'));
            this.projector.getModel(this.pjlinkAnswerHandler.bind(this, 'GETMODEL'));
            this.projector.getInfo(this.pjlinkAnswerHandler.bind(this, 'GETINFO'));
            this.projector.getClass(this.pjlinkAnswerHandler.bind(this, 'GETCLASS'));
            if (this.timers.informationDelay) {
                this.timers.informationDelay.refresh();
                this.log.debug(`PJLink refreshing informationDelay`);
            } else {
                this.log.debug(`PJLink unable to refresh informationDelay`);
            }
        } catch (err) {
            this.errorHandler(err, 'getProjectorInformation');
        }
    }

    /**
     * Called to turn the projector on or off depemding on its actual state
	 */
    async projectorOnOff() {
        try {
            this.log.info(`PJLink power button pressed`);
            // first get the projector status
            const state = await this.getStateAsync('powerStatus');
            // @ts-ignore
            const powerStatus = state.val | 0;

            // reset power button status. Set as confirmed by hardware (ack = true)
            this.setState('power', false, true);

            if (powerStatus === 0) {
                this.log.info(`PJLink Projector is currently off. Trying to switch projector on`);
                this.projector.powerOn();
                return;
            }
            if (powerStatus === 1) {
                this.log.info(`PJLink Projector is currently on. Trying to switch projector off`);
                this.projector.powerOff();
                return;
            }
            // return if cooling or warming up
            if (powerStatus === 2) {
                this.log.info(`PJLink Projector is currently cooling down. Refuse to switch power`);
                return;
            }
            if (powerStatus === 3) {
                this.log.info(`PJLink Projector is currently warming up. Refuse to switch power`);
                return;
            }
        } catch (err) {
            this.errorHandler(err, 'projectorOnOff');
        }
    }

    /**
     * Called to set the mute status
     * @param {string} type
     * @param {boolean} status
	 */
    async setMute(type, status) {
        try {
            this.log.info(`PJLink mute status changed for type: ${type} to ${status}`);

            // first get the current mute status
            let state = await this.getStateAsync('videoMuteStatus');
            // @ts-ignore
            const videoMuteStatus = state.val | false;
            state = await this.getStateAsync('audioMuteStatus');
            // @ts-ignore
            const audioMuteStatus = state.val | false;

            if (type === 'VIDEO') {
                this.log.info(`PJLink trying to set projectors video mute to ${status}`);
                this.projector.setMute({'video': status, 'audio': audioMuteStatus});
            } else if (type === 'AUDIO') {
                this.log.info(`PJLink trying to set projectors audio mute to ${status}`);
                this.projector.setMute({'video': videoMuteStatus, 'audio': status});
            } else {
                this.log.error(`PJLink setMute called with unknown type ${type}`);
            }

        } catch (err) {
            this.errorHandler(err, 'setMute');
        }
    }

    /**
     * Called as answer function from pjlink functions
     * @param {string} command called commands from PJLink to separate the value handling
	 * @param {any} pjlinkValues normaly the err and the state from the PJLink function call
	 */
    async pjlinkAnswerHandler(command, ...pjlinkValues) {
        try {
            // first look at the error state
            const error = pjlinkValues[0];
            let state = '';

            if (error) {
                this.errorHandler(error, `pjlinkAnswerHandler (command: ${command})`);

                // reset connection state
                this.setState('info.connection', false, true);

                // stop/restart timers
                if (this.timers.statusDelay) {
                    clearTimeout(this.timers.statusDelay);
                    this.timers.statusDelay = undefined;
                }
                if (this.timers.informationDelay) {
                    clearTimeout(this.timers.informationDelay);
                    this.timers.informationDelay = undefined;
                }
                if (this.timers.reconnectDelay) {
                    this.timers.reconnectDelay.refresh();
                } else {
                    this.timers.reconnectDelay = setTimeout(this.reconnectProjector.bind(this), this.config.reconnectDelay);
                }
                return;
            }

            if (pjlinkValues.length > 1) {
                state = pjlinkValues[1];
                this.log.debug(`PJLink got answer from command: '${command}', value '${JSON.stringify(state)}'`);

                // only if the connection was not established before
                const connectionState = await this.getStateAsync('info.connection');

                // @ts-ignore
                if (connectionState.val === false) {
                    // stop/restart timers
                    if (this.timers.statusDelay) {
                        this.timers.statusDelay.refresh();
                        this.log.debug(`PJLink refreshing statusDelay`);
                    } else {
                        this.timers.statusDelay = setTimeout(this.getProjectorStatus.bind(this), this.config.statusDelay);
                        this.log.debug(`PJLink setTimeout for statusDelay`);
                    }
                    if (this.timers.informationDelay) {
                        this.timers.informationDelay.refresh();
                        this.log.debug(`PJLink refreshing informationDelay`);
                    } else {
                        this.timers.informationDelay = setTimeout(this.getProjectorInformation.bind(this), this.config.informationDelay);
                        this.log.debug(`PJLink setTimeout for informationDelay`);
                    }
                    if (this.timers.reconnectDelay) {
                        clearTimeout(this.timers.reconnectDelay);
                        this.timers.reconnectDelay = undefined;
                        this.log.debug(`PJLink stopping timer reconnectDelay`);
                    }

                    // set connection state
                    this.setState('info.connection', true, true);

                    // get the information at the communication start
                    this.getProjectorInformation();
                }

                // now parse the return values
                let fan = 0;
                let lamp = 0;
                let temperature = 0;
                let cover = 0;
                let filter = 0;
                let other = 0;
                switch (command) {
                    case 'GETPOWERSTATE':
                        this.setState('powerStatus', parseInt(state), true);
                        break;

                    case 'GETINPUT':
                        // @ts-ignore
                        this.setState('input', parseInt(state.code), true);
                        break;

                    case 'GETMUTE':
                        // @ts-ignore
                        this.setState('videoMuteStatus', state.video, true);
                        // @ts-ignore
                        this.setState('audioMuteStatus', state.audio, true);
                        break;

                    case 'GETERRORS':
                        if (state) {
                            // @ts-ignore
                            fan = state.fan === 'warning' ? 1 : state.fan === 'error' ? 3 : 0;
                            // @ts-ignore
                            lamp = state.lamp === 'warning' ? 1 : state.lamp === 'error' ? 3 : 0;
                            // @ts-ignore
                            temperature = state.temperature === 'warning' ? 1 : state.temperature === 'error' ? 3 : 0;
                            // @ts-ignore
                            cover = state.cover === 'warning' ? 1 : state.cover === 'error' ? 3 : 0;
                            // @ts-ignore
                            filter = state.filter === 'warning' ? 1 : state.filter === 'error' ? 3 : 0;
                            // @ts-ignore
                            other = state.other === 'warning' ? 1 : state.other === 'error' ? 3 : 0;
                        }
                        this.setState('deviceInfo.fanErrorStatus', fan, true);
                        this.setState('deviceInfo.lampErrorStatus', lamp, true);
                        this.setState('deviceInfo.temperatureErrorStatus', temperature, true);
                        this.setState('deviceInfo.coverOpenStatus', cover, true);
                        this.setState('deviceInfo.filterErrorStatus', filter, true);
                        this.setState('deviceInfo.otherErrorStatus', other, true);
                        break;

                    case 'GETLAMPS':
                        // @ts-ignore
                        this.setState('deviceInfo.lamps.lamp1Status', parseInt(state[0].on === false ? 0 : 1), true);
                        // @ts-ignore
                        this.setState('deviceInfo.lamps.lamp1Hours', parseInt(state[0].hours), true);

                        for (let lamps = 1; lamps < state.length; lamps++) {
                            const index = lamps + 1;
                            await this.setObjectNotExistsAsync(`deviceInfo.lamps.lamp${index}Status`, {
                                'type': 'state',
                                'common': {
                                    'role': 'indicator.maintenance',
                                    'name': {
                                        'en': 'Status of lamp ' + index,
                                        'de': 'Status der Lampe ' + index,
                                        'ru': 'Статус лампы ' + index,
                                        'pt': 'Estado da lâmpada ' + index,
                                        'nl': 'Status van lamp ' + index,
                                        'fr': 'État du feu ' + index,
                                        'it': 'Stato della lampada ' + index,
                                        'es': 'Estado de la lámpara ' + index,
                                        'pl': 'Status lampy ' + index,
                                        'uk': 'Статус лампи ' + index,
                                        'zh-cn': '口粮' + index
                                    },
                                    'type': 'number',
                                    'states': {
                                        '0': 'Off',
                                        '1': 'On'
                                    },
                                    'read': true,
                                    'write': false,
                                    'def': 0
                                },
                                'native': {}
                            });
                            await this.setObjectNotExistsAsync(`deviceInfo.lamps.lamp${index}Hours`, {
                                '_id': 'deviceInfo.lamps.lamp1Hours',
                                'type': 'state',
                                'common': {
                                    'role': 'value',
                                    'name': {
                                        'en': 'Lighting time of lamp ' + index,
                                        'de': 'Leuchtdauer der Lampe ' + index,
                                        'ru': 'Время освещения лампы ' + index,
                                        'pt': 'Tempo de iluminação da lâmpada ' + index,
                                        'nl': 'Verlichtingstijd van lamp ' + index,
                                        'fr': 'Temps d\'éclairage de la lampe ' + index,
                                        'it': 'Tempo di illuminazione della lampada ' + index,
                                        'es': 'Tiempo de iluminación de la lámpara ' + index,
                                        'pl': 'Czas świetlny lampy ' + index,
                                        'uk': 'Час освітлення лампи ' + index,
                                        'zh-cn': 'A. 灯' + index
                                    },
                                    'type': 'number',
                                    'min': 0,
                                    'max': 99999,
                                    'read': true,
                                    'write': false,
                                    'def': 0
                                },
                                'native': {}
                            });
                            // @ts-ignore
                            this.setState(`deviceInfo.lamps.lamp${index}Status`, parseInt(state[lamps].on === false ? 0 : 1), true);
                            // @ts-ignore
                            this.setState(`deviceInfo.lamps.lamp${index}Hours`, parseInt(state[lamps].hours), true);
                        }
                        break;

                    case 'GETINPUTS':
                        this.setState('deviceInfo.inputsAvailable', JSON.stringify(state), true);
                        break;

                    case 'GETNAME':
                        this.setState('deviceInfo.projectorName', JSON.stringify(state), true);
                        break;

                    case 'GETMANUFACTURER':
                        this.setState('deviceInfo.projectorManufacturer', JSON.stringify(state), true);
                        break;

                    case 'GETMODEL':
                        this.setState('deviceInfo.productName', JSON.stringify(state), true);
                        break;

                    case 'GETINFO':
                        this.setState('deviceInfo.otherInfo', JSON.stringify(state), true);
                        break;

                    case 'GETCLASS':
                        this.setState('deviceInfo.class', parseInt(state), true);
                        break;

                    default:
                        this.log.info(`PJLink unsupported command '${command}'`);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'pjlinkAnswerHandler');
        }
    }

    /**
     * Called on error situations and from catch blocks
	 * @param {any} err
	 * @param {string} module
	 */
    errorHandler(err, module = '') {
        this.log.error(`PJLink error in method: [${module}] error: ${err.message}, stack: ${err.stack}`);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            // End the PJLink connection
            this.projector.disconnect();

            // Here you must clear all timeouts or intervals that may still be active
            if (this.timers.statusDelay) clearTimeout(this.timers.statusDelay);
            if (this.timers.informationDelay) clearTimeout(this.timers.informationDelay);

            // Reset the connection indicator
            this.setState('info.connection', false, true);

            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        try {
            if (state) {
                if (state.ack) {
                    this.log.debug(`PJLink state ${id} changed: ${state.val} (ack = ${state.ack})`);
                } else {
                    this.log.info(`PJLink state ${id} changed: ${state.val} (ack = ${state.ack})`);
                }
                // The state was changed
                if (!state.ack && state.val) {           // only if the state is set manually
                    const onlyId = id.replace(this.namespace + '.', '');
                    switch (onlyId) {
                        case 'power':
                            this.projectorOnOff();
                            break;
                        case 'input':
                            // the string value is parsed by the pjlink.inputCommand.
                            // For the future and Class 2 it is the preferred format because of e.g. input 3B
                            this.projector.setInput(state.val.toString());
                            break;
                        case 'videoMuteStatus':
                            this.setMute('VIDEO', state.val ? true : false);
                            break;
                        case 'audioMuteStatus':
                            this.setMute('AUDIO', state.val ? true : false);
                            break;
                    }
                }
            }
        } catch (err) {
            this.errorHandler(err, 'onStateChange');
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => {'use strict'; new Pjlink(options); };
} else {
    // otherwise start the instance directly
    new Pjlink();
}