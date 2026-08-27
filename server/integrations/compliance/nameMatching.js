'use strict';

/**
 * Name normalization and similarity shared by the sanctions list providers, so
 * OFAC and OpenSanctions screening agree on what counts as a match.
 */

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenCounts(tokens) {
  return tokens.reduce((counts, token) => {
    counts.set(token, (counts.get(token) || 0) + 1);
    return counts;
  }, new Map());
}

function containsTokens(container, candidate) {
  const available = tokenCounts(container);
  return Array.from(tokenCounts(candidate).entries())
    .every(([token, count]) => (available.get(token) || 0) >= count);
}

/**
 * Similarity of two already-normalized names in [0, 1]. Whole-token containment
 * scores high (legal-name suffixes, reordered names); partial words do not.
 */
function nameSimilarity(input, target) {
  if (input === target) return 1;
  if (input.length < 8 || target.length < 8) return 0;
  const inputTokens = input.split(' ');
  const targetTokens = target.split(' ');
  if (containsTokens(inputTokens, targetTokens) || containsTokens(targetTokens, inputTokens)) {
    return inputTokens.length === targetTokens.length ? 0.96 : 0.92;
  }
  if (Math.abs(input.length - target.length) > 3) return 0;
  const longer = Math.max(input.length, target.length);
  const previous = Array.from({ length: target.length + 1 }, (_, index) => index);
  for (let inputIndex = 1; inputIndex <= input.length; inputIndex += 1) {
    let diagonal = previous[0];
    previous[0] = inputIndex;
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      const above = previous[targetIndex];
      const cost = input[inputIndex - 1] === target[targetIndex - 1] ? 0 : 1;
      previous[targetIndex] = Math.min(
        previous[targetIndex] + 1,
        previous[targetIndex - 1] + 1,
        diagonal + cost
      );
      diagonal = above;
    }
  }
  return 1 - (previous[target.length] / longer);
}

module.exports = { normalizeName, nameSimilarity };
