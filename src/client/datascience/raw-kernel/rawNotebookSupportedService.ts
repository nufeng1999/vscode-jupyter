// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { inject, injectable } from 'inversify';
import { IS_NON_RAW_NATIVE_TEST } from '../../../test/constants';
import { traceError, traceInfo } from '../../common/logger';
import { IConfigurationService } from '../../common/types';
import { sendTelemetryEvent, setSharedProperty } from '../../telemetry';
import { Settings, Telemetry } from '../constants';
import { IRawNotebookSupportedService } from '../types';

// This class check to see if we have everything in place to support a raw kernel launch on the machine
@injectable()
export class RawNotebookSupportedService implements IRawNotebookSupportedService {
    // Keep track of our ZMQ import check, this doesn't change with settings so we only want to do this once
    private _zmqSupportedPromise: Promise<boolean> | undefined;

    constructor(@inject(IConfigurationService) private readonly configuration: IConfigurationService) {}

    // Check to see if we have all that we need for supporting raw kernel launch
    public async supported(): Promise<boolean> {
        if (!this.localLaunch()) {
            return false;
        }
        const isSupported = await this.isSupportedForLocalLaunch();
        setSharedProperty('rawKernelSupported', isSupported ? 'true' : 'false');
        return isSupported;
    }

    private async isSupportedForLocalLaunch(): Promise<boolean> {
        // Save the ZMQ support for last, since it's probably the slowest part
        return !this.isZQMDisabled() && (await this.zmqSupported()) ? true : false;
    }

    private localLaunch(): boolean {
        const settings = this.configuration.getSettings(undefined);
        const serverType: string | undefined = settings.jupyterServerType;

        if (!serverType || serverType.toLowerCase() === Settings.JupyterServerLocalLaunch) {
            return true;
        }

        return false;
    }

    // Check to see if our hidden setting has been turned on to disable local ZMQ support
    private isZQMDisabled(): boolean {
        return this.configuration.getSettings().disableZMQSupport;
    }

    // Check to see if this machine supports our local ZMQ launching
    private async zmqSupported(): Promise<boolean> {
        if (!this._zmqSupportedPromise) {
            this._zmqSupportedPromise = this.zmqSupportedImpl();
        }

        return this._zmqSupportedPromise;
    }

    private async zmqSupportedImpl(): Promise<boolean> {
        if (IS_NON_RAW_NATIVE_TEST) {
            return false;
        }
        try {
            await import('zeromq');
            traceInfo(`ZMQ install verified.`);
            sendTelemetryEvent(Telemetry.ZMQSupported);
        } catch (e) {
            traceError(`Exception while attempting zmq :`, e);
            sendTelemetryEvent(Telemetry.ZMQNotSupported);
            return false;
        }

        return true;
    }
}
