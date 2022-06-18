/**
 * @license
 * Copyright 2018 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {InferenceModel, io, ModelPredictConfig, NamedTensorMap, Tensor, util} from '@tensorflow/tfjs-core';

import * as tensorflow from '../data/compiled_api';
import {NamedTensorsMap, TensorInfo} from '../data/types';
import {OperationMapper} from '../operations/operation_mapper';

import {GraphExecutor} from './graph_executor';
import {ResourceManager} from './resource_manager';

export const TFHUB_SEARCH_PARAM = '?tfjs-format=file';
export const DEFAULT_MODEL_NAME = 'model.json';
type Url = string|io.IOHandler|io.IOHandlerSync;
type UrlIOHandler<T extends Url> = T extends string ? io.IOHandler : T;

/**
 * A `tf.GraphModel` is a directed, acyclic graph built from a
 * SavedModel GraphDef and allows inference execution.
 *
 * A `tf.GraphModel` can only be created by loading from a model converted from
 * a [TensorFlow SavedModel](https://www.tensorflow.org/guide/saved_model) using
 * the command line converter tool and loaded via `tf.loadGraphModel`.
 *
 * @doc {heading: 'Models', subheading: 'Classes'}
 */
export class GraphModel<ModelURL extends Url = string | io.IOHandler> implements
    InferenceModel {
  private executor: GraphExecutor;
  private version = 'n/a';
  private handler: UrlIOHandler<ModelURL>;
  private artifacts: io.ModelArtifacts;
  private initializer: GraphExecutor;
  private resourceManager: ResourceManager;
  private signature: tensorflow.ISignatureDef;
  private structuredOutputKeys_: string[];

  // Returns the version information for the tensorflow model GraphDef.
  get modelVersion(): string {
    return this.version;
  }

  get inputNodes(): string[] {
    return this.executor.inputNodes;
  }

  get outputNodes(): string[] {
    return this.executor.outputNodes;
  }

  get inputs(): TensorInfo[] {
    return this.executor.inputs;
  }

  get outputs(): TensorInfo[] {
    return this.executor.outputs;
  }

  get weights(): NamedTensorsMap {
    return this.executor.weightMap;
  }

  get metadata(): {} {
    return this.artifacts.userDefinedMetadata;
  }

  get modelSignature(): {} {
    return this.signature;
  }

  get structuredOutputKeys(): {} {
    return this.structuredOutputKeys_;
  }

  /**
   * @param modelUrl url for the model, or an `io.IOHandler`.
   * @param weightManifestUrl url for the weight file generated by
   * scripts/convert.py script.
   * @param requestOption options for Request, which allows to send credentials
   * and custom headers.
   * @param onProgress Optional, progress callback function, fired periodically
   * before the load is completed.
   */
  constructor(
      private modelUrl: ModelURL, private loadOptions: io.LoadOptions = {}) {
    if (loadOptions == null) {
      this.loadOptions = {};
    }
    this.resourceManager = new ResourceManager();
  }

  private findIOHandler() {
    type IOHandler = UrlIOHandler<ModelURL>;
    const path = this.modelUrl;
    if ((path as io.IOHandler).load != null) {
      // Path is an IO Handler.
      this.handler = path as IOHandler;
    } else if (this.loadOptions.requestInit != null) {
      this.handler =
          io.browserHTTPRequest(path as string, this.loadOptions) as IOHandler;
    } else {
      const handlers = io.getLoadHandlers(path as string, this.loadOptions);
      if (handlers.length === 0) {
        // For backward compatibility: if no load handler can be found,
        // assume it is a relative http path.
        handlers.push(io.browserHTTPRequest(path as string, this.loadOptions));
      } else if (handlers.length > 1) {
        throw new Error(
            `Found more than one (${handlers.length}) load handlers for ` +
            `URL '${[path]}'`);
      }
      this.handler = handlers[0] as IOHandler;
    }
  }

  /**
   * Loads the model and weight files, construct the in memory weight map and
   * compile the inference graph.
   */
  load(): UrlIOHandler<ModelURL> extends io.IOHandlerSync? boolean:
                                             Promise<boolean> {
    type IOHandler = UrlIOHandler<ModelURL>;
    this.findIOHandler();
    if (this.handler.load == null) {
      throw new Error(
          'Cannot proceed with model loading because the IOHandler provided ' +
          'does not have the `load` method implemented.');
    }

    type Result =
        IOHandler extends io.IOHandlerSync ? boolean : Promise<boolean>;

    const loadResult = this.handler.load() as ReturnType<IOHandler['load']>;
    if (util.isPromise(loadResult)) {
      return loadResult.then(artifacts => this.loadSync(artifacts)) as Result;
    }

    return this.loadSync(loadResult) as Result;
  }

  /**
   * Synchronously construct the in memory weight map and
   * compile the inference graph. Also initialize hashtable if any.
   *
   * @doc {heading: 'Models', subheading: 'Classes', ignoreCI: true}
   */
  loadSync(artifacts: io.ModelArtifacts) {
    this.artifacts = artifacts;
    const graph = this.artifacts.modelTopology as tensorflow.IGraphDef;

    let signature = this.artifacts.signature;
    if (this.artifacts.userDefinedMetadata != null) {
      const metadata = this.artifacts.userDefinedMetadata;
      if (metadata.signature != null) {
        signature = metadata.signature;
      }

      if (metadata.structuredOutputKeys != null) {
        this.structuredOutputKeys_ = metadata.structuredOutputKeys as string[];
      }
    }
    this.signature = signature;

    this.version = `${graph.versions.producer}.${graph.versions.minConsumer}`;
    const weightMap =
        io.decodeWeights(this.artifacts.weightData, this.artifacts.weightSpecs);
    this.executor = new GraphExecutor(
        OperationMapper.Instance.transformGraph(graph, this.signature));
    this.executor.weightMap = this.convertTensorMapToTensorsMap(weightMap);
    // Attach a model-level resourceManager to each executor to share resources,
    // such as `HashTable`.
    this.executor.resourceManager = this.resourceManager;

    if (artifacts.modelInitializer != null &&
        (artifacts.modelInitializer as tensorflow.IGraphDef).node != null) {
      const initializer =
          OperationMapper.Instance.transformGraph(artifacts.modelInitializer);
      this.initializer = new GraphExecutor(initializer);
      this.initializer.weightMap = this.executor.weightMap;
      // Attach a model-level resourceManager to the initializer, the
      // hashTables created from when executing the initializer will be stored
      // in the resourceManager.
      this.initializer.resourceManager = this.resourceManager;
      this.initializer.executeAsync({}, []);
    }

    return true;
  }

  /**
   * Save the configuration and/or weights of the GraphModel.
   *
   * An `IOHandler` is an object that has a `save` method of the proper
   * signature defined. The `save` method manages the storing or
   * transmission of serialized data ("artifacts") that represent the
   * model's topology and weights onto or via a specific medium, such as
   * file downloads, local storage, IndexedDB in the web browser and HTTP
   * requests to a server. TensorFlow.js provides `IOHandler`
   * implementations for a number of frequently used saving mediums, such as
   * `tf.io.browserDownloads` and `tf.io.browserLocalStorage`. See `tf.io`
   * for more details.
   *
   * This method also allows you to refer to certain types of `IOHandler`s
   * as URL-like string shortcuts, such as 'localstorage://' and
   * 'indexeddb://'.
   *
   * Example 1: Save `model`'s topology and weights to browser [local
   * storage](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage);
   * then load it back.
   *
   * ```js
   * const modelUrl =
   *    'https://storage.googleapis.com/tfjs-models/savedmodel/mobilenet_v2_1.0_224/model.json';
   * const model = await tf.loadGraphModel(modelUrl);
   * const zeros = tf.zeros([1, 224, 224, 3]);
   * model.predict(zeros).print();
   *
   * const saveResults = await model.save('localstorage://my-model-1');
   *
   * const loadedModel = await tf.loadGraphModel('localstorage://my-model-1');
   * console.log('Prediction from loaded model:');
   * model.predict(zeros).print();
   * ```
   *
   * @param handlerOrURL An instance of `IOHandler` or a URL-like,
   * scheme-based string shortcut for `IOHandler`.
   * @param config Options for saving the model.
   * @returns A `Promise` of `SaveResult`, which summarizes the result of
   * the saving, such as byte sizes of the saved artifacts for the model's
   *   topology and weight values.
   *
   * @doc {heading: 'Models', subheading: 'Classes', ignoreCI: true}
   */
  async save(handlerOrURL: io.IOHandler|string, config?: io.SaveConfig):
      Promise<io.SaveResult> {
    if (typeof handlerOrURL === 'string') {
      const handlers = io.getSaveHandlers(handlerOrURL);
      if (handlers.length === 0) {
        throw new Error(
            `Cannot find any save handlers for URL '${handlerOrURL}'`);
      } else if (handlers.length > 1) {
        throw new Error(
            `Found more than one (${handlers.length}) save handlers for ` +
            `URL '${handlerOrURL}'`);
      }
      handlerOrURL = handlers[0];
    }
    if (handlerOrURL.save == null) {
      throw new Error(
          'GraphModel.save() cannot proceed because the IOHandler ' +
          'provided does not have the `save` attribute defined.');
    }

    return handlerOrURL.save(this.artifacts);
  }

  /**
   * Execute the inference for the input tensors.
   *
   * @param input The input tensors, when there is single input for the model,
   * inputs param should be a `tf.Tensor`. For models with mutliple inputs,
   * inputs params should be in either `tf.Tensor`[] if the input order is
   * fixed, or otherwise NamedTensorMap format.
   *
   * For model with multiple inputs, we recommend you use NamedTensorMap as the
   * input type, if you use `tf.Tensor`[], the order of the array needs to
   * follow the
   * order of inputNodes array. @see {@link GraphModel.inputNodes}
   *
   * You can also feed any intermediate nodes using the NamedTensorMap as the
   * input type. For example, given the graph
   *    InputNode => Intermediate => OutputNode,
   * you can execute the subgraph Intermediate => OutputNode by calling
   *    model.execute('IntermediateNode' : tf.tensor(...));
   *
   * This is useful for models that uses tf.dynamic_rnn, where the intermediate
   * state needs to be fed manually.
   *
   * For batch inference execution, the tensors for each input need to be
   * concatenated together. For example with mobilenet, the required input shape
   * is [1, 244, 244, 3], which represents the [batch, height, width, channel].
   * If we are provide a batched data of 100 images, the input tensor should be
   * in the shape of [100, 244, 244, 3].
   *
   * @param config Prediction configuration for specifying the batch size.
   * Currently the batch size option is ignored for graph model.
   *
   * @returns Inference result tensors. If the model is converted and it
   * originally had structured_outputs in tensorflow, then a NamedTensorMap
   * will be returned matching the structured_outputs. If no structured_outputs
   * are present, the output will be single `tf.Tensor` if the model has single
   * output node, otherwise Tensor[].
   *
   * @doc {heading: 'Models', subheading: 'Classes'}
   */
  predict(inputs: Tensor|Tensor[]|NamedTensorMap, config?: ModelPredictConfig):
      Tensor|Tensor[]|NamedTensorMap {
    const outputTensors = this.execute(inputs, this.outputNodes);
    if (this.structuredOutputKeys_) {
      const outputTensorsArray =
          outputTensors instanceof Tensor ? [outputTensors] : outputTensors;
      const outputTensorMap: NamedTensorMap = {};

      outputTensorsArray.forEach(
          (outputTensor, i) => outputTensorMap[this.structuredOutputKeys_[i]] =
              outputTensor);

      return outputTensorMap;
    }
    return outputTensors;
  }

  private normalizeInputs(inputs: Tensor|Tensor[]|
                          NamedTensorMap): NamedTensorMap {
    if (!(inputs instanceof Tensor) && !Array.isArray(inputs)) {
      // The input is already a NamedTensorMap.
      return inputs;
    }
    inputs = Array.isArray(inputs) ? inputs : [inputs];
    if (inputs.length !== this.inputNodes.length) {
      throw new Error(
          'Input tensor count mismatch,' +
          `the graph model has ${this.inputNodes.length} placeholders, ` +
          `while there are ${inputs.length} input tensors.`);
    }
    return this.inputNodes.reduce((map, inputName, i) => {
      map[inputName] = (inputs as Tensor[])[i];
      return map;
    }, {} as NamedTensorMap);
  }

  private normalizeOutputs(outputs: string|string[]): string[] {
    outputs = outputs || this.outputNodes;
    return !Array.isArray(outputs) ? [outputs] : outputs;
  }

  /**
   * Executes inference for the model for given input tensors.
   * @param inputs tensor, tensor array or tensor map of the inputs for the
   * model, keyed by the input node names.
   * @param outputs output node name from the Tensorflow model, if no
   * outputs are specified, the default outputs of the model would be used.
   * You can inspect intermediate nodes of the model by adding them to the
   * outputs array.
   *
   * @returns A single tensor if provided with a single output or no outputs
   * are provided and there is only one default output, otherwise return a
   * tensor array. The order of the tensor array is the same as the outputs
   * if provided, otherwise the order of outputNodes attribute of the model.
   *
   * @doc {heading: 'Models', subheading: 'Classes'}
   */
  execute(inputs: Tensor|Tensor[]|NamedTensorMap, outputs?: string|string[]):
      Tensor|Tensor[] {
    inputs = this.normalizeInputs(inputs);
    outputs = this.normalizeOutputs(outputs);
    const result = this.executor.execute(inputs, outputs);
    return result.length > 1 ? result : result[0];
  }
  /**
   * Executes inference for the model for given input tensors in async
   * fashion, use this method when your model contains control flow ops.
   * @param inputs tensor, tensor array or tensor map of the inputs for the
   * model, keyed by the input node names.
   * @param outputs output node name from the Tensorflow model, if no outputs
   * are specified, the default outputs of the model would be used. You can
   * inspect intermediate nodes of the model by adding them to the outputs
   * array.
   *
   * @returns A Promise of single tensor if provided with a single output or
   * no outputs are provided and there is only one default output, otherwise
   * return a tensor map.
   *
   * @doc {heading: 'Models', subheading: 'Classes'}
   */
  async executeAsync(
      inputs: Tensor|Tensor[]|NamedTensorMap,
      outputs?: string|string[]): Promise<Tensor|Tensor[]> {
    inputs = this.normalizeInputs(inputs);
    outputs = this.normalizeOutputs(outputs);
    const result = await this.executor.executeAsync(inputs, outputs);
    return result.length > 1 ? result : result[0];
  }

  /**
   * Get intermediate tensors for model debugging mode (flag
   * KEEP_INTERMEDIATE_TENSORS is true).
   *
   * @doc {heading: 'Models', subheading: 'Classes'}
   */
  getIntermediateTensors(): NamedTensorsMap {
    return this.executor.getIntermediateTensors();
  }

  /**
   * Dispose intermediate tensors for model debugging mode (flag
   * KEEP_INTERMEDIATE_TENSORS is true).
   *
   * @doc {heading: 'Models', subheading: 'Classes'}
   */
  disposeIntermediateTensors() {
    this.executor.disposeIntermediateTensors();
  }

  private convertTensorMapToTensorsMap(map: NamedTensorMap): NamedTensorsMap {
    return Object.keys(map).reduce((newMap: NamedTensorsMap, key) => {
      newMap[key] = [map[key]];
      return newMap;
    }, {});
  }

  /**
   * Releases the memory used by the weight tensors and resourceManager.
   *
   * @doc {heading: 'Models', subheading: 'Classes'}
   */
  dispose() {
    this.executor.dispose();

    if (this.initializer) {
      this.initializer.dispose();
    }

    this.resourceManager.dispose();
  }
}

/**
 * Load a graph model given a URL to the model definition.
 *
 * Example of loading MobileNetV2 from a URL and making a prediction with a
 * zeros input:
 *
 * ```js
 * const modelUrl =
 *    'https://storage.googleapis.com/tfjs-models/savedmodel/mobilenet_v2_1.0_224/model.json';
 * const model = await tf.loadGraphModel(modelUrl);
 * const zeros = tf.zeros([1, 224, 224, 3]);
 * model.predict(zeros).print();
 * ```
 *
 * Example of loading MobileNetV2 from a TF Hub URL and making a prediction
 * with a zeros input:
 *
 * ```js
 * const modelUrl =
 *    'https://tfhub.dev/google/imagenet/mobilenet_v2_140_224/classification/2';
 * const model = await tf.loadGraphModel(modelUrl, {fromTFHub: true});
 * const zeros = tf.zeros([1, 224, 224, 3]);
 * model.predict(zeros).print();
 * ```
 * @param modelUrl The url or an `io.IOHandler` that loads the model.
 * @param options Options for the HTTP request, which allows to send
 *     credentials
 *    and custom headers.
 *
 * @doc {heading: 'Models', subheading: 'Loading'}
 */
export async function loadGraphModel(
    modelUrl: string|io.IOHandler,
    options: io.LoadOptions = {}): Promise<GraphModel> {
  if (modelUrl == null) {
    throw new Error(
        'modelUrl in loadGraphModel() cannot be null. Please provide a url ' +
        'or an IOHandler that loads the model');
  }
  if (options == null) {
    options = {};
  }

  if (options.fromTFHub && typeof modelUrl === 'string') {
    modelUrl = getTFHubUrl(modelUrl);
  }
  const model = new GraphModel(modelUrl, options);
  await model.load();
  return model;
}

/**
 * Load a graph model given a synchronous IO handler with a 'load' method.
 *
 * @param modelSource The `io.IOHandlerSync` that loads the model.
 *
 * @doc {heading: 'Models', subheading: 'Loading'}
 */

export function loadGraphModelSync(modelSource: io.IOHandlerSync):
    GraphModel<io.IOHandlerSync> {
  if (modelSource == null) {
    throw new Error(
        'modelUrl in loadGraphModelSync() cannot be null. Please provide a ' +
        'url or an IOHandler that loads the model');
  }
  if (!modelSource.load) {
    throw new Error(`modelUrl IO Handler ${modelSource} has no load function`);
  }
  const model = new GraphModel(modelSource);

  model.load();
  return model;
}

function getTFHubUrl(modelUrl: string): string {
  if (!modelUrl.endsWith('/')) {
    modelUrl = (modelUrl) + '/';
  }
  return `${modelUrl}${DEFAULT_MODEL_NAME}${TFHUB_SEARCH_PARAM}`;
}
