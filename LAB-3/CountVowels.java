import java.io.BufferedReader;
import java.io.FileReader;
import java.io.IOException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class CountVowels {

    // HashSet of vowels to quickly check if a character is a vowel.
    // See usage below.
    private Set<Character> vowels =
        new HashSet<Character>(Arrays.asList('a', 'e', 'i', 'o', 'u', 'y'));

    // Read a file line-by-line. Assume that each line is a paragraph.
    public void countInFile(String fileName) throws IOException {

        BufferedReader br = new BufferedReader(new FileReader(fileName));
        String line;

        // Assume one file line is a paragraph.
        while ((line = br.readLine()) != null) {
            if (line.length() == 0) {
                continue; // Skip over blank lines.
            }
            countInParagraph(line);
        }

        br.close();
    }

    // Primary function to count vowels in a paragraph. 
    // Splits paragraph string into sentences, and for each sentence,
    // counts the number of vowels.
    private void countInParagraph(String paragraph) {

        String[] sentences = splitParagraphIntoSentences(paragraph);

        for (String sentence : sentences) {
            sentence = sentence.trim(); // Remove whitespace at ends.
            int vowelCount = countVowelsInSentence(sentence);
            System.out.printf("%s : %d vowels\n", sentence, vowelCount);
        }
    }

    // Splits a paragraph string into an array of sentences. Uses a regex.
    private String[] splitParagraphIntoSentences(String paragraph) {
        return paragraph.split("\n|((?<!\\d)\\.(?!\\d))");
    }

    // Counts the number of vowels in a sentence string.
    private int countVowelsInSentence(String sentence) {

        sentence = sentence.toLowerCase();

        int result = 0;    
        int sentenceLength = sentence.length();

        for (int i = 0; i < sentenceLength; i++) {
            if (vowels.contains(sentence.charAt(i))) {
                result++;
            }
        }

        return result;
    }

    // Entry point into the program.
    public static void main(String argv[]) throws IOException {

        CountVowels cw = new CountVowels();

        cw.countInFile(argv[0]);
    }
}