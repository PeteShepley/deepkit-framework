/*
 * Deepkit Framework
 * Copyright (C) 2021 Deepkit UG, Marc J. Schmidt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 *
 * You should have received a copy of the MIT License along with this program.
 */

import { asyncOperation, CustomError } from '@deepkit/core';
import { ReceiveType } from '@deepkit/type';
import { RpcError, RpcTypes } from '../model.js';
import type { RpcMessage } from '../protocol.js';

export class UnexpectedMessageType extends CustomError {
}

function noop() {}

export class RpcMessageSubject {
    protected uncatchedNext?: RpcMessage;

    protected onReplyCallback(next: RpcMessage, subject: RpcMessageSubject) {
        this.uncatchedNext = next;
    }

    protected rejected?: (error: any) => void;

    protected catchOnReplyCallback = this.onReplyCallback.bind(this);

    constructor(
        private continuation: <T>(type: number, body?: T, schema?: ReceiveType<T>) => void,
        /**
         * Releases this subject. It is necessary that eventually every created subject is released,
         * otherwise dramatic performance decrease and memory leak will happen.
         */
        public release: () => void,
    ) {
    }

    /**
     * Called when the underlying transport disconnected.
     * This force-cleans everything up.
     */
    public disconnect(error?: Error) {
        if (this.rejected) {
            this.rejected(error || new RpcError('Connection closed'));
            this.rejected = undefined;
        }
        this.onReplyCallback = noop;
        this.release();
    }

    public next(next: RpcMessage) {
        this.onReplyCallback(next, this);
    }

    /**
     * Registers a callback that is called to handle unexpected rejections,
     * like disconnects, transport errors, or timeouts.
     */
    public onRejected(callback: (error: any) => void): this {
        this.rejected = callback;
        return this;
    }

    public onReply(callback: (next: RpcMessage, subject: RpcMessageSubject) => void): this {
        this.onReplyCallback = callback;
        if (this.uncatchedNext) {
            callback(this.uncatchedNext, this);
            this.uncatchedNext = undefined;
        }
        return this;
    }

    /**
     * Sends a message to the server in the context of this created subject.
     * If the connection meanwhile has been reconnected, and completed MessageSubject.
     */
    public send<T>(
        type: number,
        body?: T,
        schema?: ReceiveType<T>,
    ): this {
        this.continuation(type, body, schema);
        return this;
    }

    /**
     * Waits for the Ack message from the server, then closes the subject.
     */
    async ackThenClose(): Promise<undefined> {
        return asyncOperation<undefined>((resolve, reject) => {
            this.rejected = reject;
            this.onReply((next) => {
                this.onReplyCallback = this.catchOnReplyCallback;
                this.release();
                this.rejected = undefined;

                if (next.type === RpcTypes.Ack) {
                    return resolve(undefined);
                }

                if (next.isError()) {
                    return reject(next.getError());
                }

                reject(new UnexpectedMessageType(`Expected message type Ack, but received ${next.type}`));
            });
        });
    }

    /**
     * Wait for next message to arrive.
     */
    async waitNextMessage<T>(): Promise<RpcMessage> {
        return asyncOperation<any>((resolve, reject) => {
            this.rejected = reject;
            this.onReply((next) => {
                this.onReplyCallback = this.catchOnReplyCallback;
                return resolve(next);
            });
        });
    }

    /**
     * Wait for next message with body parse.
     */
    async waitNext<T>(type: number, schema?: ReceiveType<T>): Promise<T> {
        return asyncOperation<any>((resolve, reject) => {
            this.rejected = reject;
            this.onReply((next) => {
                this.onReplyCallback = this.catchOnReplyCallback;
                if (next.type === type) {
                    return resolve(schema ? next.parseBody(schema) : undefined);
                }

                if (next.isError()) {
                    this.release();
                    return reject(next.getError());
                }

                reject(new UnexpectedMessageType(`Expected message type ${type}, but received ${next.type}`));
            });
        });
    }

    /**
     * Waits for the first message of a specific type, then closes the subject.
     */
    async firstThenClose<T = RpcMessage>(type: number, schema?: ReceiveType<T>): Promise<T> {
        return asyncOperation<any>((resolve, reject) => {
            this.rejected = reject;
            this.onReply((next) => {
                this.onReplyCallback = this.catchOnReplyCallback;
                this.release();

                if (next.type === type) {
                    try {
                        return resolve(schema ? next.parseBody(schema) : next);
                    } catch (error: any) {
                        return reject(error);
                    }
                }

                if (next.isError()) {
                    this.release();
                    return reject(next.getError());
                }

                reject(new UnexpectedMessageType(`Expected message type ${type}, but received ${next.type}`));
            });
        });
    }
}
