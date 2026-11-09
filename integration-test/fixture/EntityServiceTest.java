package demo;

public class EntityServiceTest {
    @Mock
    private EntityRepository repository;

    @Test
    public void savesEntity() {
        repository.flush();
    }
}
