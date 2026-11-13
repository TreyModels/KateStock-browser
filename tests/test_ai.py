import unittest
from scripts.ai_brief import validate_commentary

class BriefTest(unittest.TestCase):
    def test_only_bounded_non_numeric_commentary(self):
        self.assertEqual(validate_commentary('走势存在分化，请注意风险。'),'走势存在分化，请注意风险。')
        for text in ('价格上涨5%', '立即买入', 'https://fake.example', 'sk-abcdef', 'x' * 501, ''):
            self.assertIsNone(validate_commentary(text))

if __name__ == '__main__': unittest.main()
