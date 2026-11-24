#!/usr/bin/env python3
"""
List the keys that Python resource scripts print, without running them.

Reads a JSON list of script paths on stdin and writes
``{path: {"keys": [{"name", "line", "col"}], "complete": bool}}`` to
stdout. ``line`` is 1-based and ``col`` 0-based, both for the string
literal the key comes from.

Resource jobs print records of ``key: value`` lines (parsed by
plainbox.impl.secure.rfc822.gen_rfc822_records: the key is everything
before the first colon). Keys are found in print() and sys.stdout.write()
calls, including keys taken from literal collections iterated by a for
loop (``for k in ("a", "b"): print(f"{k}: ...")``). ``complete`` is false
when the script may print an identifier-like key that could not be
determined statically.

Only the standard library is used so any python3 can run this.
"""

import ast
import json
import string
import sys

IDENTIFIER_CHARS = set(string.ascii_letters + string.digits + "_")
STDLIB = getattr(sys, "stdlib_module_names", None) or {
    "argparse",
    "collections",
    "glob",
    "io",
    "json",
    "logging",
    "os",
    "pathlib",
    "re",
    "shlex",
    "shutil",
    "subprocess",
    "sys",
    "time",
    "typing",
}
EXPLAIN = "--explain" in sys.argv
EXIT_CALLS = {"exit", "sys.exit", "SystemExit", "raise"}


class Dyn:
    """A part of printed text that is not known statically."""

    def __init__(self, node):
        self.node = node


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        return base and f"{base}.{node.attr}"
    return None


def str_const(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


class Scope:
    """Assignments, functions and classes of a module, class or function."""

    def __init__(self, node, parent=None):
        self.node = node
        self.parent = parent
        self.values = {}
        # name -> [(key, node)] from name["key"] = ... / name.update(...)
        self.items = {}
        self.functions = {}
        self.classes = {}
        self._children = {}
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = node.args
            every = args.posonlyargs + args.args + args.kwonlyargs
            every += [a for a in (args.vararg, args.kwarg) if a]
            for arg in every:
                self.values.setdefault(arg.arg, []).append(None)
        for stmt in node.body:
            self._collect(stmt)

    def child(self, node):
        if node not in self._children:
            self._children[node] = Scope(node, self)
        return self._children[node]

    def _collect(self, node):
        """Assignments in `node`, not in nested functions or classes."""
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self.functions[node.name] = node
            self.values.setdefault(node.name, []).append(None)
            return
        if isinstance(node, ast.ClassDef):
            self.classes[node.name] = node
            self.values.setdefault(node.name, []).append(None)
            return
        if isinstance(node, ast.Lambda):
            return
        if isinstance(node, ast.Assign):
            for target in node.targets:
                self._assign(target, node.value)
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
            if node.value is not None:
                self._assign(node.target, node.value)
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            self._assign(node.target, None)
        elif isinstance(node, ast.With):
            for item in node.items:
                if item.optional_vars:
                    self._assign(item.optional_vars, None)
        elif isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute) and isinstance(
                func.value, ast.Name
            ):
                self._method(func.value.id, func.attr, node)
        for child in ast.iter_child_nodes(node):
            self._collect(child)

    def _assign(self, target, value):
        if isinstance(target, ast.Name):
            self.values.setdefault(target.id, []).append(value)
        elif isinstance(target, ast.Subscript) and isinstance(
            target.value, ast.Name
        ):
            key = target.slice
            if isinstance(key, ast.Index):  # Python < 3.9
                key = key.value
            self.items.setdefault(target.value.id, []).append(
                (str_const(key), key)
            )
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                self._assign(elt, None)
        elif isinstance(target, ast.Starred):
            self._assign(target.value, None)

    def _method(self, name, method, call):
        items = self.items.setdefault(name, [])
        if method == "setdefault" and call.args:
            items.append((str_const(call.args[0]), call.args[0]))
        elif method == "update":
            for arg in call.args:
                items.append((None, arg))
            for kw in call.keywords:
                items.append((kw.arg, kw))
        elif method in ("append", "extend", "add", "insert"):
            # A collection filled at runtime
            items.append((None, call))
        if not items:
            del self.items[name]

    def lookup(self, name):
        scope = self
        while scope:
            if name in scope.values or name in scope.items:
                return scope
            scope = scope.parent
        return None

    def function(self, name):
        """The scope of a function callable as `name`, if local."""
        scope = self
        while scope:
            if name in scope.functions:
                return scope.child(scope.functions[name])
            if name in scope.values or name in scope.items:
                return None
            scope = scope.parent
        return None

    def class_scope(self):
        """The class whose attributes `self.<name>` refers to."""
        scope = self
        while scope:
            if isinstance(scope.node, ast.ClassDef):
                return scope
            scope = scope.parent
        return None


def returns(function):
    """Return statements of a function, not of nested ones."""
    found = []

    def walk(node):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.Return):
                found.append(child)
            elif not isinstance(
                child,
                (
                    ast.FunctionDef,
                    ast.AsyncFunctionDef,
                    ast.ClassDef,
                    ast.Lambda,
                ),
            ):
                walk(child)

    walk(function)
    return found


def union(results):
    """Concatenated pairs, or None if any is unknown."""
    pairs = []
    for result in results:
        if result is None:
            return None
        pairs.extend(result)
    return pairs


def known(pairs):
    if pairs is None or any(key is None for key, _ in pairs):
        return None
    return pairs


MAX_DEPTH = 8


def strings(node, scope, mode, depth=0):
    """
    The strings `node` may yield, as (string, node) pairs, or None when
    unknown. Mode "iter": elements when iterated; "keys": dict keys.
    """
    if node is None or scope is None or depth > MAX_DEPTH:
        return None
    depth += 1
    if isinstance(node, ast.Name):
        return name_strings(node.id, scope, mode, depth)
    if (
        isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id == "self"
        and scope.class_scope()
    ):
        return name_strings(node.attr, scope.class_scope(), mode, depth)
    if isinstance(node, ast.Call):
        return call_strings(node, scope, mode, depth)
    if mode == "value":
        constant = str_const(node)
        return None if constant is None else [(constant, node)]
    if mode == "iter":
        if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
            return known([(str_const(elt), elt) for elt in node.elts])
        if isinstance(node, ast.Dict):
            return strings(node, scope, "keys", depth)
        return None
    if isinstance(node, ast.Dict):
        return union(
            (
                [(str_const(k), k)]
                if k is not None
                # {**other}
                else strings(v, scope, "keys", depth)
            )
            for k, v in zip(node.keys, node.values)
        )
    return None


def name_strings(name, scope, mode, depth):
    found = scope.lookup(name)
    if not found:
        return None
    results = [
        strings(v, found, mode, depth) for v in found.values.get(name, [])
    ]
    if mode == "keys":
        for key, key_node in found.items.get(name, []):
            results.append(
                [(key, key_node)]
                if key is not None
                else (
                    strings(key_node, found, "keys", depth)
                    if not isinstance(key_node, ast.Call)
                    else None
                )
            )
    elif found.items.get(name):
        return None
    return known(union(results)) if results else None


def call_strings(node, scope, mode, depth):
    name = dotted(node.func)
    args = node.args
    if name in ("sorted", "reversed", "list", "tuple", "set", "frozenset"):
        return strings(args[0], scope, mode, depth) if len(args) == 1 else None
    if name in ("dict", "OrderedDict", "collections.OrderedDict"):
        results = [[(kw.arg, kw)] for kw in node.keywords]
        if len(args) == 1:
            arg = args[0]
            if isinstance(arg, ast.Call) and dotted(arg.func) == "list":
                arg = arg.args[0] if arg.args else arg
            if isinstance(arg, ast.Call) and dotted(arg.func) == "zip":
                results.append(
                    strings(arg.args[0], scope, "iter", depth)
                    if arg.args
                    else None
                )
            else:
                results.append(strings(arg, scope, "keys", depth))
        elif args:
            return None
        return known(union(results))
    if isinstance(node.func, ast.Attribute) and not args:
        method = node.func.attr
        if method in ("keys", "copy") and mode != "value":
            return strings(node.func.value, scope, "keys", depth)
    function = None
    if isinstance(node.func, ast.Name):
        function = scope.function(node.func.id)
    elif (
        isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "self"
        and scope.class_scope()
    ):
        function = scope.class_scope().function(node.func.attr)
    if function is not None:
        found = returns(function.node)
        if found:
            return known(
                union(strings(r.value, function, mode, depth) for r in found)
            )
    return None


def loop_strings(iterable, scope, position, depth=0):
    """Strings bound to a for target (`position` in a tuple target)."""
    if position is None:
        return strings(iterable, scope, "iter", depth)
    if isinstance(iterable, ast.Call):
        name = dotted(iterable.func)
        args = iterable.args
        if name in ("sorted", "reversed", "list") and len(args) == 1:
            return loop_strings(args[0], scope, position, depth + 1)
        if name == "enumerate" and args and position == 1:
            return strings(args[0], scope, "iter", depth)
        if name == "zip" and position < len(args):
            return strings(args[position], scope, "iter", depth)
        if (
            isinstance(iterable.func, ast.Attribute)
            and iterable.func.attr == "items"
            and not args
            and position == 0
        ):
            return strings(iterable.func.value, scope, "keys", depth)
    return None


class Analyzer(ast.NodeVisitor):
    def __init__(self):
        self.keys = []
        self.complete = True
        self.imported = set()
        self.scope = None
        self.current = None
        self.reasons = []
        # Loop / comprehension bindings: name -> (target, iterable, scope)
        self.loops = []

    # Name resolution ---------------------------------------------------

    def loop_binding(self, name):
        for target, iterable, scope in reversed(self.loops):
            names = (
                [target]
                if isinstance(target, ast.Name)
                else (
                    list(target.elts)
                    if isinstance(target, (ast.Tuple, ast.List))
                    else []
                )
            )
            for position, elt in enumerate(names):
                if isinstance(elt, ast.Name) and elt.id == name:
                    tuple_target = not isinstance(target, ast.Name)
                    return iterable, scope, position if tuple_target else None
        return None

    def names_for(self, node):
        """(key, node) pairs a dynamic part may print, or None."""
        if isinstance(node, ast.Name):
            binding = self.loop_binding(node.id)
            if binding:
                iterable, scope, position = binding
                return loop_strings(iterable, scope, position)
        constant = str_const(node)
        if constant is not None:
            return [(constant, node)]
        return strings(node, self.scope, "value")

    # Text templates ----------------------------------------------------

    def template(self, node):
        """Printed text as a list of str and Dyn parts."""
        constant = str_const(node)
        if constant is not None:
            return [(constant, node)]
        if isinstance(node, ast.JoinedStr):
            parts = []
            for value in node.values:
                if isinstance(value, ast.FormattedValue):
                    parts.append(Dyn(value.value))
                else:
                    parts.extend(self.template(value))
            return parts
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return self.template(node.left) + self.template(node.right)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod):
            fmt = str_const(node.left)
            if fmt is not None:
                args = (
                    list(node.right.elts)
                    if isinstance(node.right, ast.Tuple)
                    else [node.right]
                )
                return self.percent(fmt, node.left, args)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            base = str_const(node.func.value)
            if base is not None and node.func.attr == "format":
                return self.brace(base, node.func.value, node)
            if base is not None and node.func.attr == "join" and node.args:
                arg = node.args[0]
                if isinstance(arg, (ast.GeneratorExp, ast.ListComp)):
                    return self.comprehension(arg, base)
        if isinstance(node, ast.Name):
            pairs = self.names_for(node)
            if pairs and len(pairs) == 1:
                return [pairs[0]]
        return [Dyn(node)]

    def comprehension(self, comp, sep):
        pushed = 0
        for generator in comp.generators:
            self.loops.append((generator.target, generator.iter, self.scope))
            pushed += 1
        try:
            return self.template(comp.elt) + [(sep, None)]
        finally:
            del self.loops[len(self.loops) - pushed :]

    def percent(self, fmt, node, args):
        parts = []
        index = 0
        i = 0
        while i < len(fmt):
            if fmt[i] == "%" and fmt[i + 1 : i + 2] == "%":
                parts.append(("%", node))
                i += 2
            elif fmt[i] == "%":
                j = i + 1
                while j < len(fmt) and fmt[j] not in "diouxXeEfFgGcrsa":
                    j += 1
                arg = args[index] if index < len(args) else None
                index += 1
                parts.append(Dyn(arg))
                i = j + 1
            else:
                j = fmt.find("%", i)
                j = len(fmt) if j == -1 else j
                parts.append((fmt[i:j], node))
                i = j
        return parts

    def brace(self, fmt, node, call):
        parts = []
        auto = 0
        try:
            parsed = list(string.Formatter().parse(fmt))
        except ValueError:
            return [Dyn(call)]
        for literal, field, _, _ in parsed:
            if literal:
                parts.append((literal, node))
            if field is None:
                continue
            name = field.split(".")[0].split("[")[0]
            arg = None
            if name == "":
                arg = call.args[auto] if auto < len(call.args) else None
                auto += 1
            elif name.isdigit():
                position = int(name)
                if position < len(call.args):
                    arg = call.args[position]
            else:
                arg = next(
                    (kw.value for kw in call.keywords if kw.arg == name), None
                )
            parts.append(Dyn(arg))
        return parts

    # Keys --------------------------------------------------------------

    def emit(self, parts):
        """Record the keys at the start of each printed line."""
        line = []
        at_start = True
        for part in parts + [("\n", None)]:
            if isinstance(part, Dyn):
                if at_start:
                    line.append(part)
                continue
            text, node = part
            while text:
                if not at_start:
                    newline = text.find("\n")
                    if newline == -1:
                        break
                    text = text[newline + 1 :]
                    at_start = True
                    line = []
                    continue
                colon = text.find(":")
                newline = text.find("\n")
                if newline != -1 and (colon == -1 or newline < colon):
                    line.append((text[:newline], node))
                    self.no_key(line)
                    line = []
                    text = text[newline + 1 :]
                    continue
                if colon == -1:
                    line.append((text, node))
                    break
                line.append((text[:colon], node))
                self.key(line)
                at_start = False
                text = text[colon + 1 :]

    def no_key(self, line):
        # A dynamic line with no colon may itself be "key: value"
        if any(isinstance(p, Dyn) for p in line):
            text = "".join(p[0] for p in line if not isinstance(p, Dyn))
            if not text.strip() and not text.startswith((" ", "\t")):
                self.incomplete(self.current)

    def key(self, line):
        if not line:
            return
        first = line[0]
        if not isinstance(first, Dyn) and first[0][:1] in (" ", "\t"):
            return  # Continuation line
        dyn = [p for p in line if isinstance(p, Dyn)]
        literal = "".join(p[0] for p in line if not isinstance(p, Dyn))
        if not dyn:
            name = literal.strip()
            if name:
                self.add(name, line[0][1])
            return
        if set(literal.strip()) - IDENTIFIER_CHARS:
            # Never an identifier: requires can't reference it
            return
        if len(dyn) == 1 and not literal.strip():
            pairs = self.names_for(dyn[0].node) if dyn[0].node else None
            if pairs:
                for name, node in pairs:
                    self.add(name.strip(), node)
                return
        self.incomplete(self.current)

    def add(self, name, node):
        if not name:
            return
        line = getattr(node, "lineno", 0)
        col = getattr(node, "col_offset", 0)
        self.keys.append({"name": name, "line": line, "col": col})

    def incomplete(self, node):
        self.complete = False
        self.reasons.append(getattr(node, "lineno", 0))

    # Visitors ----------------------------------------------------------

    def visit_Module(self, node):
        self.scope = Scope(node)
        self.generic_visit(node)

    def visit_FunctionDef(self, node):
        outer = self.scope
        self.scope = outer.child(node)
        self.generic_visit(node)
        self.scope = outer

    visit_AsyncFunctionDef = visit_FunctionDef
    visit_ClassDef = visit_FunctionDef

    def visit_Import(self, node):
        for alias in node.names:
            if alias.name.split(".")[0] not in STDLIB:
                self.imported.add(alias.asname or alias.name.split(".")[0])

    def visit_ImportFrom(self, node):
        if node.level or (node.module or "").split(".")[0] not in STDLIB:
            for alias in node.names:
                self.imported.add(alias.asname or alias.name)

    def visit_For(self, node):
        self.visit(node.iter)
        self.loops.append((node.target, node.iter, self.scope))
        for stmt in node.body:
            self.visit(stmt)
        self.loops.pop()
        for stmt in node.orelse:
            self.visit(stmt)

    visit_AsyncFor = visit_For

    def visit_comprehension_node(self, node):
        pushed = 0
        for generator in node.generators:
            self.visit(generator.iter)
            self.loops.append((generator.target, generator.iter, self.scope))
            pushed += 1
        for child in ast.iter_child_nodes(node):
            if not isinstance(child, ast.comprehension):
                self.visit(child)
        del self.loops[len(self.loops) - pushed :]

    visit_ListComp = visit_comprehension_node
    visit_SetComp = visit_comprehension_node
    visit_GeneratorExp = visit_comprehension_node
    visit_DictComp = visit_comprehension_node

    def visit_Expr(self, node):
        call = node.value
        if isinstance(call, ast.Call) and self.foreign(call):
            # An imported function may print records itself
            self.incomplete(node)
        self.generic_visit(node)

    def foreign(self, call):
        name = dotted(call.func)
        return bool(name) and name.split(".")[0] in self.imported

    def visit_Call(self, node):
        name = dotted(node.func)
        self.current = node
        if name == "print":
            self.print_call(node)
        elif name in ("sys.stdout.write", "stdout.write") and node.args:
            self.emit(self.template(node.args[0]))
        elif name in EXIT_CALLS and node.args:
            arg = node.args[0]
            if isinstance(arg, ast.Call) and self.foreign(arg):
                self.incomplete(node)
        self.generic_visit(node)

    def print_call(self, node):
        keywords = {kw.arg: kw.value for kw in node.keywords}
        target = keywords.get("file")
        if target is not None and dotted(target) not in (
            "sys.stdout",
            "stdout",
        ):
            return
        if any(isinstance(arg, ast.Starred) for arg in node.args):
            self.incomplete(node)
            return
        sep = keywords.get("sep")
        sep_part = (str_const(sep), sep) if sep is not None else (" ", None)
        if sep_part[0] is None:
            sep_part = Dyn(sep)
        parts = []
        for i, arg in enumerate(node.args):
            if i:
                parts.append(sep_part)
            parts.extend(self.template(arg))
        self.emit(parts)


def analyse(path):
    try:
        with open(path, encoding="utf-8") as stream:
            tree = ast.parse(stream.read(), path)
    except (OSError, SyntaxError, ValueError, UnicodeDecodeError):
        return {"keys": [], "complete": False}
    analyzer = Analyzer()
    analyzer.visit(tree)
    seen = set()
    keys = []
    for key in analyzer.keys:
        marker = (key["name"], key["line"], key["col"])
        if marker not in seen:
            seen.add(marker)
            keys.append(key)
    result = {"keys": keys, "complete": analyzer.complete}
    if EXPLAIN:
        result["incomplete_lines"] = analyzer.reasons
    return result


def main():
    paths = json.load(sys.stdin)
    json.dump({path: analyse(path) for path in paths}, sys.stdout)


if __name__ == "__main__":
    main()
