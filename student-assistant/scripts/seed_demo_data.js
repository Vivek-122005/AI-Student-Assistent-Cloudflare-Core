import { chunkText } from '../src/chunker.js';
import {
  embedText,
  storeRawNote,
  storeNoteChunks,
  storeChunkEmbedding
} from '../src/knowledge.js';
import { saveWikiNode } from '../src/wiki.js';

function toSlug(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function formatTime12(time24) {
  const m = String(time24 || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return String(time24 || '');
  const hh = parseInt(m[1], 10);
  const mm = m[2];
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const hr12 = ((hh + 11) % 12) + 1;
  return `${hr12}:${mm} ${suffix}`;
}

function buildExamDescription({ category }) {
  // Used by the bot for answering “When is my OS exam?” with a time range.
  return `Time window: 10:00-13:00; Student: ${STUDENT.name}; Enrolment: ${STUDENT.enrollmentNo}; Category: ${category}.`;
}

const STUDENT = {
  name: 'vivek',
  enrollmentNo: '230119',
  semester: 6,
  cgpa: '8.00',
  branch: 'Computer Science and AI'
};

const SUBJECT_REGISTRY = [
  { subject_code: 'AML', subject_name: 'Advanced Machine Learning', category: 'Major' },
  { subject_code: 'ADM', subject_name: 'Advanced Discrete Mathematics', category: 'Major' },
  { subject_code: 'OS', subject_name: 'Operating Systems', category: 'Major' },
  { subject_code: 'DL', subject_name: 'Deep Learning', category: 'Major' },
  { subject_code: 'DevOps', subject_name: 'DevOps', category: 'Elective' }
];

const EXAMS = [
  {
    date: '2026-05-18',
    title: 'CSA334 Robotics & Intelligent Control Systems (Elective)',
    subject: 'Robotics & Intelligent Control Systems',
    type: 'exam',
    metadata: 'Elective'
  },
  {
    date: '2026-05-18',
    title: 'CSA326 Full Stack Development (Elective)',
    subject: 'Full Stack Development',
    type: 'exam',
    metadata: 'Elective'
  },
  {
    date: '2026-05-19',
    title: 'CSA332 Deep Learning (Major)',
    subject: 'Deep Learning',
    type: 'exam',
    metadata: 'Major'
  },
  {
    date: '2026-05-20',
    title: 'CSA325 Operating Systems (Major)',
    subject: 'Operating Systems',
    type: 'exam',
    metadata: 'Major'
  },
  {
    date: '2026-05-21',
    title: 'BUE212 AI Digital Tools for Business (Major)',
    subject: 'AI Digital Tools for Business',
    type: 'exam',
    metadata: 'Major'
  },
  {
    date: '2026-05-22',
    title: 'CSA331 Advanced Discrete Mathematics (Major)',
    subject: 'Advanced Discrete Mathematics',
    type: 'exam',
    metadata: 'Major'
  },
  {
    date: '2026-05-25',
    title: 'CSA333 Advanced Machine Learning (Major)',
    subject: 'Advanced Machine Learning',
    type: 'exam',
    metadata: 'Major'
  }
];

function buildStructuredNoteText({ topic, concepts, keyTopics, definitions, formulas, examSummary }) {
  const section = (header, lines) => `${header}\n${lines.map(l => `- ${l}`).join('\n')}`;

  return [
    `# ${topic}`,
    ``,
    section('## A. Concepts', concepts),
    ``,
    section('## B. Key topics', keyTopics),
    ``,
    section('## C. Definitions', definitions),
    ``,
    section('## D. Important formulas / ideas', formulas),
    ``,
    `## E. Exam-focused summary`,
    `- ${examSummary}`
  ].join('\n');
}

async function eventExists(env, { title, date, type }) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM events WHERE title = ? AND event_date = ? AND type = ?`
  ).bind(title, date, type).all();
  return results && results.length > 0;
}

async function seedExams(env) {
  let inserted = 0;

  // Keep the demo deterministic: remove any previously seeded "exam" events
  // within the demo window so answers don't show duplicates.
  const minDate = EXAMS.map(e => e.date).sort()[0];
  const maxDate = EXAMS.map(e => e.date).sort().slice(-1)[0];
  await env.DB.prepare(
    `DELETE FROM events WHERE type = ? AND event_date BETWEEN ? AND ?`
  ).bind('exam', minDate, maxDate).run();

  for (const exam of EXAMS) {
    const exists = await eventExists(env, exam);
    if (exists) continue;

    await env.DB.prepare(
      `INSERT INTO events (title, description, event_date, event_time, type)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      exam.title,
      buildExamDescription({ category: exam.metadata }),
      exam.date,
      '10:00 AM – 1:00 PM',
      exam.type
    ).run();
    inserted++;
  }

  return { inserted };
}

async function seedStudentProfile(env, { force = false } = {}) {
  const key = 'profile:student';
  if (!force) {
    const existing = await env.NOTES_KV.get(key);
    if (existing) return { skipped: true };
  }

  await env.NOTES_KV.put(key, JSON.stringify({
    semester: STUDENT.semester,
    cgpa: STUDENT.cgpa,
    branch: STUDENT.branch,
    name: STUDENT.name,
    enrollmentNo: STUDENT.enrollmentNo
  }));

  return { inserted: true };
}

async function seedSubjectRegistry(env, { force = false } = {}) {
  const registryKey = 'subjects:registry';
  if (!force) {
    const existing = await env.NOTES_KV.get(registryKey);
    if (existing) return { skipped: true };
  }

  await env.NOTES_KV.put(registryKey, JSON.stringify(SUBJECT_REGISTRY));

  // Also write per-subject entries (handy for future features / admin tooling)
  for (const s of SUBJECT_REGISTRY) {
    const perKey = `subjects:${s.subject_code}`;
    const existing = await env.NOTES_KV.get(perKey);
    if (!force && existing) continue;
    await env.NOTES_KV.put(perKey, JSON.stringify(s));
  }

  return { inserted: true };
}

function buildTopicData() {
  const OS = {
    subject: 'OS',
    topics: [
      {
        topic: 'CPU Scheduling',
        concepts: [
          'Deciding which process/thread uses the CPU next to improve responsiveness and throughput',
          'Tradeoffs between waiting time, turnaround time, fairness, and context-switch overhead',
          'Preemptive vs non-preemptive execution (whether the OS can interrupt a running process)'
        ],
        keyTopics: [
          'Process states and the ready queue',
          'Performance metrics: waiting time, turnaround time, response time, throughput, CPU utilization',
          'FCFS, SJF/SRTF, Priority scheduling, Round Robin (quantum), and aging to reduce starvation',
          'Context switching cost and why it changes with scheduling frequency'
        ],
        definitions: [
          'Burst time: CPU time required by a process to complete execution (excluding I/O wait)',
          'Waiting time: time spent in the ready queue',
          'Turnaround time: completion time − arrival time',
          'Response time: first time the process starts executing − arrival time',
          'Preemption: ability to take CPU from a process before completion'
        ],
        formulas: [
          'CPU utilization = (time CPU is busy) / (total time)',
          'Average waiting time = (Σ waiting time of processes) / n',
          'Average turnaround time = (Σ turnaround time of processes) / n'
        ],
        examSummary: 'Pick the right algorithm for the scenario (e.g., Round Robin for time-sharing, SJF/SRTF for minimizing average waiting).'
      },
      {
        topic: 'Deadlock',
        concepts: [
          'A set of processes is deadlocked when each waits for an event/resource that only the others can release',
          'Deadlock is characterized by the classic four Coffman conditions',
          'OS strategies: prevention, avoidance, detection, and recovery'
        ],
        keyTopics: [
          'Mutual exclusion, hold-and-wait, no preemption, circular wait',
          'Resource Allocation Graph (RAG) and Wait-For Graph (WFG)',
          'Detection vs avoidance (Banker’s algorithm) vs prevention',
          'Recovery techniques (process termination, resource preemption)'
        ],
        definitions: [
          'Deadlock: permanent blocking of processes due to resource dependency cycle',
          'Starvation: a process never gets resources even if deadlock does not occur',
          'Safe state (Banker’s): there exists an order of process completions without violating availability',
          'Need matrix: Need = Max − Allocation'
        ],
        formulas: [
          'Need[i][j] = Max[i][j] − Allocation[i][j]',
          'A process i can proceed if ∀j: Need[i][j] ≤ Available[j]',
          'Banker safety check: repeatedly find a runnable process, simulate completion, and release its resources'
        ],
        examSummary: 'Memorize the four conditions and be able to apply Banker’s (safety check) to decide safe vs unsafe states.'
      },
      {
        topic: 'Memory Management',
        concepts: [
          'Keeping track of which parts of memory are used and mapping processes into memory',
          'Handling fragmentation and supporting efficient allocation/deallocation',
          'Using virtual memory via paging/swapping to improve multiprogramming'
        ],
        keyTopics: [
          'Address binding (compile-time, load-time, run-time)',
          'Contiguous allocation and fragmentation (internal vs external)',
          'Swapping and page fault handling',
          'Working set concept and locality (why it matters for paging/replacement)'
        ],
        definitions: [
          'Internal fragmentation: wasted space within an allocated partition',
          'External fragmentation: wasted space between allocated partitions',
          'Page fault: event when a referenced page is not in RAM',
          'Working set: the set of pages actively used in a time window'
        ],
        formulas: [
          'Page Fault Rate = (number of page faults) / (total memory references)',
          'Memory access time idea: if page fault probability is p, AMAT ≈ (1−p)·RAM_access + p·(page_fault_penalty)'
        ],
        examSummary: 'Be ready to explain fragmentation, address mapping, and the steps taken on a page fault (trap → page lookup → bring in page → resume).'
      },
      {
        topic: 'Paging vs Segmentation',
        concepts: [
          'Paging and segmentation are two ways to organize memory and translate logical addresses to physical addresses',
          'Paging improves efficiency and fixed-size management; segmentation models memory as logical units',
          'They differ in granularity of protection and how addresses are interpreted'
        ],
        keyTopics: [
          'Paging: fixed-size pages/frames and page tables',
          'Segmentation: variable-size segments and segment tables (base/limit)',
          'Translation mechanisms: TLB and multi-level tables',
          'Protection and sharing implications for each approach'
        ],
        definitions: [
          'Page: fixed-size block of virtual memory',
          'Frame: fixed-size block of physical memory',
          'Segment: variable-size logical unit (e.g., code, stack, data)',
          'Logical address: address produced by the program; translated to physical address by MMU'
        ],
        formulas: [
          'Paging address: logical (p, offset) → physical = frame(p) || offset',
          'Segmentation address: logical (s, offset) → physical = base(s) + offset'
        ],
        examSummary: 'Know the address formats and translation rules, and contrast protection/sharing granularity in paging vs segmentation.'
      }
    ]
  };

  const AML = {
    subject: 'AML',
    topics: [
      {
        topic: 'Gradient Boosting',
        concepts: [
          'Ensemble method that builds a strong predictor by adding weak learners stage by stage',
          'Learns by minimizing a differentiable loss using gradient information',
          'Produces an additive model that refines residual errors over iterations'
        ],
        keyTopics: [
          'Base learner: often small regression trees',
          'Learning rate (η) and its role in shrinking each step',
          'Loss functions and how gradients/residuals depend on the current prediction',
          'Bias/variance behavior and typical overfitting controls (trees depth, regularization, early stopping)'
        ],
        definitions: [
          'Additive model: F(x) = Σ η·h_m(x)',
          'Gradient boosting: chooses h_m to reduce the loss using gradients',
          'Residual (for boosting intuition): the part not yet explained by earlier learners'
        ],
        formulas: [
          'F_m(x) = F_{m-1}(x) + η·h_m(x)',
          'Gradient for loss L(y, F): r_i = -∂L(y_i, F)/∂F |_{F=F_{m-1}}',
          'At each step: fit h_m to approximate the negative gradient / residuals'
        ],
        examSummary: 'Explain how boosting uses gradients at each stage and how learning rate + weak learner capacity control overfitting.'
      },
      {
        topic: 'Neural Networks',
        concepts: [
          'Parametric function approximators built from layers of linear transformations plus non-linear activations',
          'Backpropagation enables efficient computation of gradients for training',
          'The network learns hierarchical representations'
        ],
        keyTopics: [
          'Forward pass: affine transforms + activations',
          'Activation functions: sigmoid/tanh/ReLU (why non-linearity matters)',
          'Loss functions: mean squared error for regression, cross-entropy for classification',
          'Regularization hooks: weight decay and dropout (conceptually)'
        ],
        definitions: [
          'Neuron: unit that computes weighted sum + bias then applies activation',
          'Layer: collection of neurons producing activations',
          'Weights: learnable parameters (W) controlling feature combinations',
          'Bias: learnable offset allowing shifting of activation'
        ],
        formulas: [
          'z^{(l)} = W^{(l)} a^{(l-1)} + b^{(l)}',
          'a^{(l)} = σ(z^{(l)})',
          'Cross-entropy loss: L = -Σ y log(p)'
        ],
        examSummary: 'Be able to write the forward equations and describe how backprop updates weights to reduce the loss.'
      },
      {
        topic: 'Bias-Variance Tradeoff',
        concepts: [
          'Generalization error is affected by both systematic error (bias) and sensitivity to data noise (variance)',
          'Model complexity typically reduces bias but increases variance',
          'Good performance comes from balancing both'
        ],
        keyTopics: [
          'Underfitting vs overfitting interpretation',
          'Regularization as a bias-variance control',
          'Ensemble learning as variance reduction (intuition)'
        ],
        definitions: [
          'Bias: difference between expected prediction and the true function',
          'Variance: variability of predictions across different training sets',
          'Noise: irreducible error due to randomness in the data'
        ],
        formulas: [
          'For squared error regression: E[(y−ŷ)^2] = Bias^2 + Variance + Noise',
          'Bias(x) = E[ f̂(x) ] − f(x)',
          'Variance(x) = E[( f̂(x) − E[f̂(x)] )^2]'
        ],
        examSummary: 'State the decomposition (bias^2 + variance + noise) and explain how changing complexity/regularization shifts the balance.'
      },
      {
        topic: 'Regularization',
        concepts: [
          'Regularization discourages overly complex models to improve generalization',
          'Acts as a penalty on parameters or training dynamics',
          'Common types include L1 (sparsity) and L2 (weight decay)'
        ],
        keyTopics: [
          'L2 regularization (ridge): shrinks weights',
          'L1 regularization (lasso): encourages sparsity',
          'Early stopping as an implicit regularizer (conceptually)',
          'Dropout as stochastic regularization (conceptually)'
        ],
        definitions: [
          'Weight decay: adding a penalty term proportional to weight magnitudes',
          'Sparsity: many parameters set to/near zero'
        ],
        formulas: [
          'L2: L_reg = L + (λ/2)·||w||^2',
          'L1: L_reg = L + λ·||w||_1',
          'Where λ controls strength of regularization'
        ],
        examSummary: 'Know the objective functions for L1/L2 and explain which one tends to produce sparse weights (L1).'
      }
    ]
  };

  const DL = {
    subject: 'DL',
    topics: [
      {
        topic: 'CNN',
        concepts: [
          'Convolutional Neural Networks use local receptive fields and weight sharing',
          'Designed to process grid-like data such as images',
          'Stacks of conv + nonlinearity + pooling progressively learn higher-level features'
        ],
        keyTopics: [
          'Convolution, stride, padding, and output feature map sizing',
          'Pooling (max/avg) and invariance vs information loss',
          'Parameter sharing and reduced complexity vs fully connected layers',
          'Typical pipeline: Conv → ReLU → Pool → Conv → ... → Fully connected → Softmax'
        ],
        definitions: [
          'Kernel/filter: small weight matrix slid over input feature maps',
          'Stride: step size between convolution applications',
          'Padding: added border to control output size',
          'Feature map: output of applying a kernel'
        ],
        formulas: [
          'Output size (for 1D): (W − F + 2P)/S + 1 (apply per dimension for 2D)',
          'Convolution output: y = Σ Σ x * w + b (sum over kernel elements)',
          'Softmax: p_k = exp(z_k)/Σ_j exp(z_j)'
        ],
        examSummary: 'Be able to compute output dimensions with stride/padding and explain why convolutions reduce parameters.'
      },
      {
        topic: 'RNN',
        concepts: [
          'Recurrent Neural Networks model sequences by maintaining a hidden state over time',
          'They share the same parameters across time steps',
          'Training uses Backpropagation Through Time (BPTT)'
        ],
        keyTopics: [
          'Vanilla RNN recurrence and hidden state updates',
          'Vanishing/exploding gradients (why simple RNNs struggle long-term)',
          'LSTM/GRU ideas (gates for memory retention) — conceptual'
        ],
        definitions: [
          'Hidden state h_t: memory of previous inputs',
          'Time step: one element in a sequence (t = 1..T)',
          'BPTT: unrolling the RNN and applying backprop through time'
        ],
        formulas: [
          'h_t = tanh(W_x x_t + W_h h_{t-1} + b_h)',
          'y_t = W_y h_t + b_y (then often softmax/sigmoid depending on task)',
          'Gradients follow the chain rule through all time steps (leading to vanishing/exploding)'
        ],
        examSummary: 'Write the RNN update equations and explain BPTT plus the gradient issues for long sequences.'
      },
      {
        topic: 'Backpropagation',
        concepts: [
          'Backpropagation efficiently computes gradients for all parameters using the chain rule',
          'Training is usually gradient descent (or variants like Adam)',
          'Forward pass computes predictions; backward pass propagates error signals'
        ],
        keyTopics: [
          'Loss function → gradients',
          'Learning rate and parameter updates',
          'Computational graph intuition'
        ],
        definitions: [
          'Gradient: partial derivative of loss with respect to a parameter',
          'Learning rate (α): step size in gradient descent'
        ],
        formulas: [
          'Gradient descent update: w := w − α · ∂L/∂w',
          'Bias update: b := b − α · ∂L/∂b',
          'Chain rule: ∂L/∂θ = (∂L/∂a) · (∂a/∂z) · (∂z/∂θ) (schematic)'
        ],
        examSummary: 'Know how gradients flow backward via the chain rule and how updates reduce training loss.'
      },
      {
        topic: 'Transformers',
        concepts: [
          'Transformers rely on attention rather than recurrence for sequence modeling',
          'Self-attention lets each token attend to all other tokens',
          'Positional information is added so the model knows token order'
        ],
        keyTopics: [
          'Scaled dot-product attention',
          'Multi-head attention and why it helps capture different relationships',
          'Positional encoding (sinusoidal or learned) — conceptual',
          'Encoder/decoder blocks with feed-forward layers and residual connections'
        ],
        definitions: [
          'Query (Q), Key (K), Value (V): learned vectors used to compute attention',
          'Attention weights: normalized similarity scores between tokens'
        ],
        formulas: [
          'Attention(Q, K, V) = softmax((QK^T)/sqrt(d_k)) · V',
          'Multi-head attention: concatenate heads after projecting into different subspaces',
          'Sinusoidal positional encoding (conceptual): uses sin/cos with different frequencies'
        ],
        examSummary: 'Be able to state the attention formula and explain how positional encoding and multi-head attention work together.'
      }
    ]
  };

  const ADM = {
    subject: 'ADM',
    topics: [
      {
        topic: 'Graph Theory',
        concepts: [
          'Graphs model relationships and connectivity between objects',
          'Many OS/DS/algorithm problems reduce to graph traversal or shortest paths',
          'Exam problems often require applying standard graph algorithms'
        ],
        keyTopics: [
          'Representations: adjacency matrix vs adjacency list',
          'Traversal: BFS and DFS (and time complexity)',
          'Shortest paths: Dijkstra (non-negative weights), Bellman-Ford',
          'Spanning trees: Kruskal/Prim, and Euler paths/trails'
        ],
        definitions: [
          'Vertex (node) and edge',
          'Degree of a vertex',
          'Path and cycle',
          'Tree and spanning tree',
          'Euler trail: uses every edge exactly once'
        ],
        formulas: [
          'Euler trail condition (connected graph): number of vertices with odd degree is 0 or 2',
          'Complexity reminder: BFS/DFS are O(V+E) with adjacency lists'
        ],
        examSummary: 'Know key graph properties (like odd-degree for Euler trails) and algorithm selection for traversal/shortest paths.'
      },
      {
        topic: 'Combinatorics',
        concepts: [
          'Combinatorics counts how many ways events can occur without listing them',
          'Most problems use permutations/combinations plus inclusion–exclusion or recurrence'
        ],
        keyTopics: [
          'Factorials and binomial coefficients',
          'Permutations P(n,r) and combinations C(n,r)',
          'Inclusion–exclusion principle',
          'Recurrence relations like Pascal’s identity for nCr'
        ],
        definitions: [
          'Permutation: ordering matters',
          'Combination: ordering does not matter',
          'Binomial coefficient: C(n,r)'
        ],
        formulas: [
          'P(n,r) = n! / (n−r)!',
          'C(n,r) = n! / (r!(n−r)!)',
          'Pascal identity: C(n,r) = C(n−1,r−1) + C(n−1,r)'
        ],
        examSummary: 'Be comfortable switching between factorial/binomial forms and applying inclusion–exclusion for overlapping cases.'
      },
      {
        topic: 'Recurrence Relations',
        concepts: [
          'Recurrence relations define sequences by relating a term to earlier terms',
          'They appear naturally in divide-and-conquer algorithm analysis',
          'Typical solutions use characteristic equations, iteration, or Master theorem'
        ],
        keyTopics: [
          'Linear recurrences with constant coefficients',
          'Characteristic equation method',
          'Master theorem for T(n)=aT(n/b)+f(n)',
          'Time complexity interpretation from recurrence'
        ],
        definitions: [
          'Characteristic equation: polynomial whose roots help form the closed-form solution',
          'Master theorem: compares f(n) with n^{log_b a}'
        ],
        formulas: [
          'For a_n = c1 a_{n-1} + c2 a_{n-2}: characteristic r^2 = c1 r + c2',
          'Master theorem rough: if f(n) = Θ(n^k) then compare k vs log_b(a)'
        ],
        examSummary: 'Practice converting recurrences into closed forms or applying Master theorem to get asymptotic complexity.'
      }
    ]
  };

  const DevOps = {
    subject: 'DevOps',
    topics: [
      {
        topic: 'CI/CD',
        concepts: [
          'CI (Continuous Integration) automates build + test on every change to detect issues early',
          'CD (Continuous Delivery/Deployment) automates packaging and rollout to environments',
          'The goal is faster, safer releases through repeatable pipelines'
        ],
        keyTopics: [
          'Pipeline stages: build, test, scan, package, deploy',
          'Automated tests: unit/integration/e2e (conceptually)',
          'Rollback strategies and environment promotion',
          'DORA metrics to measure delivery performance'
        ],
        definitions: [
          'Pipeline: an ordered set of steps executed automatically',
          'Artifact: build output that gets deployed (e.g., container image/tag)',
          'Deployment frequency: how often releases happen'
        ],
        formulas: [
          'Change failure rate = (number of failed deployments) / (total deployments)',
          'Lead time: time from commit to production release',
          'Error budget (SRE): error_budget = 1 − uptime/SLO'
        ],
        examSummary: 'Be able to describe a typical CI/CD pipeline and mention DORA metrics (deployment frequency, lead time, failure rate, restore time).'
      },
      {
        topic: 'Docker',
        concepts: [
          'Docker packages applications with their dependencies using containers',
          'A Docker image is an immutable template; a container is a running instance',
          'Dockerfile defines how images are built reproducibly'
        ],
        keyTopics: [
          'Dockerfile layers and caching',
          'Images vs containers vs volumes',
          'Networking basics: exposing ports and service-to-service communication',
          'Common commands: build, run, tag, push/pull (conceptually)'
        ],
        definitions: [
          'Image: read-only template with filesystem + metadata',
          'Container: running process isolated by namespaces/cgroups',
          'Volume: persistent storage managed by Docker'
        ],
        formulas: [
          'Dockerfile layering idea: each instruction creates a layer; changes to earlier layers can invalidate later cache',
          'Port publishing: host_port:container_port'
        ],
        examSummary: 'Know the purpose of Dockerfile, image/container differences, and why layering improves build speed.'
      },
      {
        topic: 'Kubernetes',
        concepts: [
          'Kubernetes orchestrates containers at scale across clusters',
          'It manages desired state: if you declare replicas, it keeps matching reality',
          'It provides service discovery, scaling, and self-healing'
        ],
        keyTopics: [
          'Core objects: Pod, Deployment, Service, Ingress, ConfigMap, Secret',
          'Scheduling and scaling: replicas, rolling updates',
          'Service types (ClusterIP/LoadBalancer) — conceptually',
          'Namespaces and how they isolate resources'
        ],
        definitions: [
          'Pod: smallest deployable unit containing one or more containers',
          'Deployment: declarative controller for managing replica sets',
          'Service: stable network endpoint for a set of pods',
          'Ingress: HTTP routing to services'
        ],
        formulas: [
          'Desired replicas: replicas_desired set by Deployment; controller reconciles actual to desired',
          'Resource requests/limits: requests guide scheduling, limits cap runtime usage'
        ],
        examSummary: 'Understand pods vs deployments vs services and be able to explain how Kubernetes maintains desired state (restarts/rollouts/scaling).'
      },
      {
        topic: 'Monitoring',
        concepts: [
          'Monitoring collects metrics/logs to observe system health',
          'Alerting helps respond quickly when SLOs are threatened',
          'Observability spans metrics, logs, and traces'
        ],
        keyTopics: [
          'Metrics: latency, throughput, error rate, resource usage',
          'Logs: debugging and audit trails',
          'Tracing: request-level visibility (conceptually)',
          'Alerting rules: thresholds, burn rate, anomaly detection (conceptually)'
        ],
        definitions: [
          'SLI (Service Level Indicator): measured behavior',
          'SLO (Service Level Objective): target level of SLI',
          'Alert: notification when an objective is at risk'
        ],
        formulas: [
          'Error budget = 1 − (observed_uptime / SLO_uptime)',
          'Error rate = errors / total_requests'
        ],
        examSummary: 'Be able to list key monitoring signals and explain how SLO/error budget concepts drive alerting.'
      }
    ]
  };

  return { OS, AML, DL, ADM, DevOps };
}

async function ensureStructuredNoteKV(env, { kvKey, note }) {
  const existing = await env.NOTES_KV.get(kvKey);
  if (existing) return false;
  await env.NOTES_KV.put(kvKey, JSON.stringify(note));
  return true;
}

async function seedStructuredTopicNotes(env, { subject, topics, force = false }) {
  let insertedNotes = 0;
  let insertedWiki = 0;
  let embeddedChunks = 0;

  const subjectSlug = toSlug(subject);

  // Use chunk sizes that keep the demo compact (fewer embeddings).
  const chunkSize = 1600;
  const overlap = 150;

  for (const t of topics) {
    const topic = t.topic;
    const topicSlug = toSlug(topic);
    const noteId = `demo-${subjectSlug}-${topicSlug}`;
    const topicKey = String(topic).replace(/\//g, '-');
    const kvKey = `/notes/${subject}/${topicKey}`;

    if (!force) {
      const existing = await env.NOTES_KV.get(kvKey);
      if (existing) continue;

      // Backstop dedupe: if an older demo run ingested embeddings but didn't create the
      // structured `/notes/...` key, we still skip to avoid vector duplicates.
      const rawNoteKey = `note:${noteId}`;
      const existingRaw = await env.NOTES_KV.get(rawNoteKey);
      if (existingRaw) continue;
    }

    const noteText = buildStructuredNoteText({
      topic,
      concepts: t.concepts,
      keyTopics: t.keyTopics,
      definitions: t.definitions,
      formulas: t.formulas,
      examSummary: t.examSummary
    });

    const chunks = chunkText(noteText, chunkSize, overlap);

    await storeRawNote(env, noteId, noteText, {
      subject,
      topic,
      sourceType: 'seed_demo'
    });

    await storeNoteChunks(env, noteId, chunks, {
      subject,
      topic,
      sourceType: 'seed_demo'
    });

    for (let i = 0; i < chunks.length; i++) {
      const embedding = await embedText(env, chunks[i]);
      await storeChunkEmbedding(env, noteId, i, chunks[i], embedding, { subject, topic });
      embeddedChunks++;
    }

    const structuredKVInserted = await ensureStructuredNoteKV(env, {
      kvKey,
      note: {
        subject,
        topic,
        topicSlug,
        noteId,
        content: noteText,
        chunks,
        student: {
          name: STUDENT.name,
          enrollmentNo: STUDENT.enrollmentNo
        }
      }
    });

    if (structuredKVInserted) insertedNotes++;

    // Deterministic wiki node for summarization (no LLM extraction needed).
    const related = topics
      .filter(x => x.topic !== topic)
      .slice(0, 3)
      .map(x => x.topic);

    const conceptSlug = toSlug(topic);
    await saveWikiNode(env, {
      concept: topic,
      conceptSlug,
      subject,
      summary: `${topic}: ${t.examSummary}`.replace(/^[-–\s]*/, ''),
      keyPoints: [
        t.concepts[0],
        t.keyTopics[0],
        t.definitions[0],
        ...(t.formulas[0] ? [t.formulas[0]] : [])
      ].filter(Boolean).slice(0, 5),
      relatedConcepts: related,
      sourceNoteIds: [noteId],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    insertedWiki++;
  }

  return { insertedNotes, insertedWiki, embeddedChunks };
}

export async function seedDemoData(env, { force = false } = {}) {
  const result = {
    events: { inserted: 0 },
    studentProfile: null,
    subjectRegistry: null,
    notes: {}
  };

  // 1) D1 events
  result.events = await seedExams(env);

  // 2) Student profile + registry
  result.studentProfile = await seedStudentProfile(env, { force });
  result.subjectRegistry = await seedSubjectRegistry(env, { force });

  // 3) Notes + embeddings + wiki nodes
  const allTopics = buildTopicData();

  for (const [subject, def] of Object.entries(allTopics)) {
    result.notes[subject] = await seedStructuredTopicNotes(env, {
      subject: def.subject,
      topics: def.topics,
      force
    });
  }

  return result;
}

