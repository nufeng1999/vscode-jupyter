// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { inject, injectable, named } from 'inversify';
import { CancellationToken, Memento } from 'vscode';
import { IWorkspaceService } from '../../common/application/types';
import { IFileSystem } from '../../common/platform/types';
import { getKernelId } from '../jupyter/kernels/helpers';
import { LocalKernelSpecConnectionMetadata, PythonKernelConnectionMetadata } from '../jupyter/kernels/types';
import { IJupyterKernelSpec } from '../types';
import { LocalKernelSpecFinderBase } from './localKernelSpecFinderBase';
import { JupyterPaths } from './jupyterPaths';
import { PYTHON_LANGUAGE } from '../../common/constants';
import { IPythonExtensionChecker } from '../../api/types';
import { captureTelemetry } from '../../telemetry';
import { Telemetry } from '../constants';
import { IMemento, GLOBAL_MEMENTO } from '../../common/types';
import { traceInfo } from '../../common/logger';

/**
 * This class searches for kernels on the file system in well known paths documented by Jupyter.
 * This will return Python, Julia, R etc kernels.
 * Returns all kernels regardless of whether Python extension is installed or not.
 */
@injectable()
export class LocalKnownPathKernelSpecFinder extends LocalKernelSpecFinderBase {
    private _oldKernelSpecsFolder?: string;
    private get oldKernelSpecsFolder() {
        return this._oldKernelSpecsFolder || this.memento.get<string>('OLD_KERNEL_SPECS_FOLDER__', '');
    }
    constructor(
        @inject(IFileSystem) fs: IFileSystem,
        @inject(IWorkspaceService) workspaceService: IWorkspaceService,
        @inject(JupyterPaths) private readonly jupyterPaths: JupyterPaths,
        @inject(IPythonExtensionChecker) extensionChecker: IPythonExtensionChecker,
        @inject(IMemento) @named(GLOBAL_MEMENTO) private readonly memento: Memento
    ) {
        super(fs, workspaceService, extensionChecker);
        if (this.oldKernelSpecsFolder) {
            traceInfo(
                `Old kernelspecs (created by Jupyter extension) stored in directory ${this.oldKernelSpecsFolder}`
            );
        }
    }
    /**
     * @param {boolean} includePythonKernels Include/exclude Python kernels in the result.
     */
    @captureTelemetry(Telemetry.KernelListingPerf, { kind: 'localKernelSpec' })
    public async listKernelSpecs(
        includePythonKernels: boolean,
        cancelToken?: CancellationToken
    ): Promise<(LocalKernelSpecConnectionMetadata | PythonKernelConnectionMetadata)[]> {
        return this.listKernelsWithCache(includePythonKernels ? 'IncludePython' : 'ExcludePython', false, async () => {
            // First find the on disk kernel specs and interpreters
            const kernelSpecs = await this.findKernelSpecs(cancelToken);

            return kernelSpecs
                .filter((item) => {
                    if (includePythonKernels) {
                        return true;
                    }
                    return item.language !== PYTHON_LANGUAGE;
                })
                .map(
                    (k) =>
                        <LocalKernelSpecConnectionMetadata>{
                            kind: 'startUsingLocalKernelSpec',
                            kernelSpec: k,
                            interpreter: undefined,
                            id: getKernelId(k)
                        }
                );
        });
    }
    private async findKernelSpecs(cancelToken?: CancellationToken): Promise<IJupyterKernelSpec[]> {
        let results: IJupyterKernelSpec[] = [];

        // Find all the possible places to look for this resource
        const paths = await this.jupyterPaths.getKernelSpecRootPaths(cancelToken);
        const searchResults = await this.findKernelSpecsInPaths(paths, cancelToken);
        await Promise.all(
            searchResults.map(async (resultPath) => {
                // Add these into our path cache to speed up later finds
                const kernelspec = await this.getKernelSpec(
                    resultPath.kernelSpecFile,
                    resultPath.interpreter,
                    cancelToken
                );

                if (kernelspec) {
                    results.push(kernelspec);
                }
            })
        );

        // Filter out duplicates. This can happen when
        // 1) Conda installs kernel
        // 2) Same kernel is registered in the global location
        // We should have extra metadata on the global location pointing to the original
        const originalSpecFiles = new Set<string>();
        results.forEach((r) => {
            if (r.metadata?.originalSpecFile) {
                originalSpecFiles.add(r.metadata?.originalSpecFile);
            }
        });
        results = results.filter((r) => !r.specFile || !originalSpecFiles.has(r.specFile));

        // There was also an old bug where the same item would be registered more than once. Eliminate these dupes
        // too.
        const unique: IJupyterKernelSpec[] = [];
        const byDisplayName = new Map<string, IJupyterKernelSpec>();
        results.forEach((r) => {
            const existing = byDisplayName.get(r.display_name);
            if (existing && existing.path !== r.path) {
                // This item is a dupe but has a different path to start the exe
                unique.push(r);
            } else if (!existing) {
                unique.push(r);
                byDisplayName.set(r.display_name, r);
            }
        });

        return unique;
    }
}
