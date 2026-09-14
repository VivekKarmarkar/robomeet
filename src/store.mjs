import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store extends EventEmitter {
  constructor(directory) {
    super();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'state.json');
    this.state = { version: 1, cursor: 0, meeting: { status: 'idle' }, voice: { desired: 'stopped', status: 'idle' }, mode: 'listen', context: '', title: '', slides: [], slideIndex: 0, notes: [], jobs: [], events: [] };
    try { this.state = { ...this.state, ...JSON.parse(readFileSync(this.file, 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read durable Robomeet state; refusing to overwrite it.'); }
    this.state.meeting = { ...this.state.meeting, status: 'idle', admitted: false };
    this.state.voice = { desired: 'stopped', status: 'idle' };
    this.save();
  }
  save() {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600, flush: true });
    renameSync(temporary, this.file);
  }
  snapshot() { return structuredClone({ ...this.state, events: this.state.events.slice(-100) }); }
  telemetry(patch) { Object.assign(this.state, patch); this.emit('telemetry', this.snapshot()); }
  update(patch, type = 'state.changed', data = {}) {
    Object.assign(this.state, patch);
    return this.event(type, data);
  }
  event(type, data = {}) {
    const event = { id: randomUUID(), cursor: ++this.state.cursor, type, at: new Date().toISOString(), data };
    this.state.events.push(event);
    this.save();
    this.emit('change', this.snapshot());
    return event;
  }
  queueJob({ sessionId, callId, responseId, delegationId, request }) {
    const existing = this.state.jobs.find(job => job.sessionId === sessionId && job.callId === callId);
    if (existing) return structuredClone(existing);
    const job = { id: randomUUID(), sessionId, callId, responseId, delegationId, request, status: 'pending', createdAt: new Date().toISOString(), meetingUrl: this.state.meeting.url || null, context: this.state.context };
    this.state.jobs.push(job);
    this.event('agent.request', job);
    return structuredClone(job);
  }
  reply(id, result) {
    const job = this.state.jobs.find(item => item.id === id);
    if (!job) throw Object.assign(new Error('Unknown job ID'), { status: 404 });
    if (job.status === 'completed') {
      if (job.result !== result) throw Object.assign(new Error('Job already has a different result'), { status: 409 });
      return structuredClone(job);
    }
    job.status = 'completed'; job.result = result; job.completedAt = new Date().toISOString();
    this.event('agent.result', job);
    return structuredClone(job);
  }
  note(text, source = 'user') {
    const note = { id: randomUUID(), text, source, at: new Date().toISOString() };
    this.state.notes.push(note); this.event('note.added', note); return note;
  }
  readEvents(after = 0, limit = 100, types) {
    const events = this.state.events.filter(event => event.cursor > after && (!types || types.includes(event.type))).slice(0, limit);
    // When the page is full, do not skip later matching events. Otherwise advance past excluded events.
    const cursor = events.length === limit ? events.at(-1).cursor : Math.max(after, this.state.cursor);
    return { events: structuredClone(events), cursor, jobs: structuredClone(this.state.jobs.filter(job => job.status === 'pending')) };
  }
  async listen(after = 0, timeoutMs = 50000, signal, types) {
    const deadline = Date.now() + Math.min(50000, Math.max(0, timeoutMs));
    for (;;) {
      const result = this.readEvents(after, 100, types);
      if (result.events.length || signal?.aborted || Date.now() >= deadline) return result;
      await new Promise(resolve => {
        let timer;
        const done = () => { clearTimeout(timer); this.off('change', done); signal?.removeEventListener('abort', done); resolve(); };
        this.on('change', done);
        timer = setTimeout(done, Math.max(0, deadline - Date.now()));
        signal?.addEventListener('abort', done, { once: true });
        if (signal?.aborted) done();
      });
    }
  }
  async waitJob(id, signal) {
    for (;;) {
      if (signal?.aborted) return null;
      const job = this.state.jobs.find(item => item.id === id);
      if (!job || job.status === 'completed') return job ? structuredClone(job) : null;
      await this.listen(this.state.cursor, 50000, signal);
    }
  }
}
