enum AlyteDocumentVLMGrammar {
  /// Flat, fixed-order rows keep constrained decoding tractable on the 2B on-device model.
  /// Every value remains untrusted until it is grounded back to source OCR observations.
  static let root = #"""
root ::= "{" ws "\"rows\"" ws ":" ws "[" ws rows? ws "]" ws "}"
rows ::= row (ws "," ws row)*
row ::= "{" ws "\"label\"" ws ":" ws string ws "," ws "\"value\"" ws ":" ws nullable-string ws "," ws "\"unit\"" ws ":" ws nullable-string ws "," ws "\"reference_interval\"" ws ":" ws nullable-string ws "," ws "\"flag\"" ws ":" ws nullable-string ws "}"
nullable-string ::= "null" | string
string ::= "\"" char* "\""
char ::= [^"\\] | "\\" escape
escape ::= ["\\/bfnrt] | "u" hex hex hex hex
hex ::= [0-9a-fA-F]
ws ::= [ \t\n\r]*
"""#
}
