"use strict";

// Evaluate an expression in Reverse Polish Notation (RPN).
// tokens: array of strings, e.g. ["3", "4", "-"] means 3 - 4 = -1.
// Supported operators: + - * /  (binary, standard RPN operand order).
//
// There is a subtle bug here. Common cases may look fine; run it yourself
// against tricky inputs to find where it diverges from correct RPN semantics.
function evalRpn(tokens) {
  const stack = [];
  for (const t of tokens) {
    if (t === "+" || t === "-" || t === "*" || t === "/") {
      const a = stack.pop();
      const b = stack.pop();
      let r;
      if (t === "+") r = a + b;
      else if (t === "*") r = a * b;
      else if (t === "-") r = a - b;
      else r = a / b;
      stack.push(r);
    } else {
      stack.push(Number(t));
    }
  }
  return stack.pop();
}

module.exports = { evalRpn };
