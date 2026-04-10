import * as blockly from 'blockly';
import { FieldLabelSerializable, FieldTextInput, FieldConfig } from 'blockly';
import './FieldProofStatus';

/*
Adapted from https://github.com/aneilmac/blockly-plugin-lean under the Apache 2.0 license
*/

/**
 * Custom field for theorem statements with monospace styling.
 */
class FieldTheoremStatement extends FieldLabelSerializable {
  constructor(value?: string) {
    super(value ?? '');
  }

  initView(): void {
    super.initView();
    // Add custom CSS class to the text element
    if (this.textElement_) {
      blockly.utils.dom.addClass(this.textElement_, 'blocklyMonospace');
    }
  }

  static fromJson(options: FieldConfig & { text?: string }): FieldTheoremStatement {
    return new FieldTheoremStatement(options.text);
  }
}

/**
 * Custom editable text field with monospace styling.
 */
class FieldMonospaceInput extends FieldTextInput {
  constructor(value?: string) {
    super(value ?? '');
  }

  initView(): void {
    super.initView();
    // Add custom CSS class to the text element
    if (this.textElement_) {
      blockly.utils.dom.addClass(this.textElement_, 'blocklyMonospace');
    }
  }

  static fromJson(options: FieldConfig & { text?: string }): FieldMonospaceInput {
    return new FieldMonospaceInput(options.text);
  }
}

// Register the custom field types
blockly.fieldRegistry.register('field_theorem_statement', FieldTheoremStatement);
blockly.fieldRegistry.register('field_monospace_input', FieldMonospaceInput);

export function defineBlocks() {
  defineLemma();
  defineProposition();
  defineTactics();
  defineMisc();
}

type TacticProps = { name: string, msg: string };
export const singleArgTactics: TacticProps[] = [
  { name: 'unfold', msg: 'unfold' },
  { name: 'apply', msg: 'apply' },
  { name: 'exact', msg: 'exactly' },
  { name: 'intro', msg: 'intro' },
  { name: 'use', msg: 'use' },
  { name: 'specialize', msg: 'specialize' },
  { name: 'choose', msg: 'choose' },
];

function defineMisc() {
  function single_arg_tactic(props: TacticProps) {
    const { name, msg } = props;
    return {
      'type': `tactic_${name}`,
      'message0': `${msg} %1`,
      'args0': [
        {
          'type': 'input_value',
          'name': 'ARG',
          'check': 'proposition',
          'align': 'LEFT',
        },
      ],
      'inputsInline': false,
      'previousStatement': 'tactic',
      'nextStatement': 'tactic',
      'style': 'logic_blocks',
      'tooltip': name,
      'helpUrl': name,
    };
  }
  blockly.defineBlocksWithJsonArray(singleArgTactics.map(single_arg_tactic));
}

function defineLemma() {
  blockly.defineBlocksWithJsonArray([
    {
      'type': 'lemma',
      'message0': 'theorem %1 %2   %3 %4 because %5 %6 %7',
      'args0': [
        {
          'type': 'field_label_serializable',
          'name': 'THEOREM_NAME',
          'text': 'theorem_name',
        },
        {
          'type': 'input_dummy',
        },
        {
          'type': 'field_theorem_statement',
          'name': 'THEOREM_DECLARATION',
          'text': 'theorem_statement',
        },
        {
          'type': 'input_dummy',
        },
        {
          'type': 'input_statement',
          'name': 'LEMMA_PROOF',
          'check': 'tactic',
        },
        {
          'type': 'field_proof_status',
          'name': 'PROOF_STATUS',
        },
        {
          'type': 'input_dummy',
        },
      ],
      'inputsInline': false,
      'style': 'procedure_blocks',
      'tooltip': '',
      'helpUrl': '',
    },
  ]);
}

function defineProposition() {
  blockly.defineBlocksWithJsonArray([
    {
      'type': 'prop_declaration',
      'message0': '%1 : %2',
      'args0': [
        {
          'type': 'field_monospace_input',
          'name': 'VARIABLE_DECL',
          'text': 'default',
        },
        {
          'type': 'field_monospace_input',
          'name': 'VARIABLE_DEF',
          'text': 'default',
        },
      ],
      'previousStatement': 'prop_declaration',
      'nextStatement': 'prop_declaration',
      'style': 'variable_blocks',
      'tooltip': '',
      'helpUrl': '',
    },
    {
      'type': 'prop',
      'message0': '%1',
      'args0': [
        {
          'type': 'field_monospace_input',
          'name': 'PROP_NAME',
          'text': 'h',
        },
      ],
      'output': 'proposition',
      'style': 'variable_blocks',
      'tooltip': '',
      'helpUrl': '',
    },
    {
      'type': 'prop_dynamic',
      'message0': '%1',
      'args0': [
        {
          'type': 'field_monospace_input',
          'name': 'PROP_NAME',
          'text': 'h',
        },
      ],
      'output': 'proposition',
      'style': 'variable_dynamic_blocks',
      'tooltip': '',
      'helpUrl': '',
    },
  ]);
}

function defineTactics() {
  blockly.defineBlocksWithJsonArray([
    {
      'type': 'tactic_refl',
      'message0': 'reflexivity',
      'previousStatement': 'tactic',
      'nextStatement': 'tactic',
      'tooltip': 'refl proves goals of the form X = X.',
      'helpUrl': 'refl',
      'style': 'logic_blocks',
    },
    {
      'type': 'tactic_ring_nf',
      'message0': 'ring_nf',
      'previousStatement': 'tactic',
      'nextStatement': 'tactic',
      'tooltip': 'ring_nf simplifies algebraic expressions.',
      'helpUrl': 'ring_nf',
      'style': 'logic_blocks',
    },
    {
      'type': 'tactic_rw',
      'message0': 'rewrite %1 %2',
      'args0': [
        {
          'type': 'field_dropdown',
          'name': 'DIRECTION_TYPE',
          'options': [
            [
              '→',
              'RIGHT',
            ],
            [
              '←',
              'LEFT',
            ],
          ],
        },
        {
          'type': 'input_value',
          'name': 'REWRITE_SOURCE',
          'check': 'proposition',
          'align': 'CENTRE',
        },
      ],
      'inputsInline': false,
      'previousStatement': 'tactic',
      'nextStatement': 'tactic',
      'style': 'logic_blocks',
      'tooltip': 'rewrite',
      'helpUrl': 'rewrite',
    },
    {
      'type': 'tactic_rw_at',
      'message0': 'rewrite %1 at %2',
      'previousStatement': 'tactic',
      'nextStatement': 'tactic',
      'args0': [
        {
          'type': 'input_value',
          'name': 'REWRITE_SOURCE',
          'check': 'proposition',
        },
        {
          'type': 'input_value',
          'name': 'REWRITE_TARGET',
          'check': 'proposition',
        },
      ],
      'inputsInline': false,
      'style': 'logic_blocks',
      'tooltip': 'rewrite_at',
      'helpUrl': 'rewrite_at',
    },
    {
      'type': 'tactic_sorry',
      'message0': 'sorry',
      'previousStatement': 'tactic',
      'colour': 330,
      'tooltip': 'hole in proof',
      'helpUrl': 'refl',
    },
    {
      'type': 'tactic_other',
      'message0': '%1',
      'args0': [
        {
          'type': 'field_monospace_input',
          'name': 'PROP_NAME',
          'text': 'h',
        },
      ],
      'nextStatement': 'tactic',
      'previousStatement': 'tactic',
      'colour': 110,
      'tooltip': 'other tactic',
      'helpUrl': 'other tactic',
    },
    {
      "type": "tactic_constructor",
      "tooltip": "",
      "helpUrl": "",
      "message0": "pair %1 %2 %3 %4 %5 %6",
      "args0": [
        {
          "type": "input_statement",
          "name": "BODY1"
        },
        {
          "type": "field_proof_status",
          "name": "STATUS_1"
        },
        {
          "type": "input_dummy"
        },
        {
          "type": "input_statement",
          "name": "BODY2"
        },
        {
          "type": "field_proof_status",
          "name": "STATUS_2"
        },
        {
          "type": "input_dummy"
        }
      ],
      'previousStatement': 'tactic',
      'nextStatement': 'tactic',
      "colour": 165
    },
    {
      "type": "tactic_show",
      "tooltip": "tactic_show",
      "helpUrl": "tactic_show",
      "message0": "show %1 by %2 %3 %4",
      "args0": [
        {
          "type": "input_value",
          "name": "GOAL"
        },
        {
          "type": "input_statement",
          "name": "PROOF"
        },
        {
          "type": "field_proof_status",
          "name": "PROOF_STATUS"
        },
        {
          "type": "input_dummy"
        },
      ],
      "output": "proposition",
      "style": "text_blocks",
    },
    {
      "type": "tactic_have",
      "tooltip": "Introduce a local lemma",
      "helpUrl": "have",
      "message0": "have %1 : %2 %3 by %4 %5 %6",
      "args0": [
        {
          "type": "field_monospace_input",
          "name": "NAME",
          "text": "h"
        },
        {
          "type": "field_monospace_input",
          "name": "TYPE",
          "text": "True"
        },
        {
          "type": "input_dummy"
        },
        {
          "type": "input_statement",
          "name": "PROOF",
          "check": "tactic"
        },
        {
          "type": "field_proof_status",
          "name": "PROOF_STATUS"
        },
        {
          "type": "input_dummy"
        }
      ],
      "previousStatement": "tactic",
      "nextStatement": "tactic",
      "style": "procedure_blocks"
    }
  ]);
}
